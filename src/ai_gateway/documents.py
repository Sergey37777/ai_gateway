"""Документы (этап 6): записи, протокол хранилища и реализация на SQLAlchemy (PostgreSQL).

Текст хранится целиком в колонке `text`; правка — запись всего текста с проверкой `revision`.
Вопросы к документу — диалоги этапа 5 со ссылкой `document_id` (см. `conversations.py`).
ORM-строки наружу не выходят — только frozen dataclass'ы.
"""

import uuid
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Protocol

from sqlalchemy import ColumnElement, case, delete, func, literal, select, tuple_, update
from sqlalchemy import cast as cast_
from sqlalchemy.dialects.postgresql import REGCONFIG
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ai_gateway.db.models import ConversationRow, DocumentRow
from ai_gateway.db.session import SNIPPET_OPTIONS, session_scope
from ai_gateway.errors import document_conflict, document_not_found

DocumentFormat = Literal["markdown", "text"]

MAX_TITLE = 200
MAX_FILENAME = 255
DEFAULT_LIMIT = 30
MAX_LIMIT = 100


@dataclass(frozen=True, slots=True)
class DocumentMeta:
    id: uuid.UUID
    title: str
    filename: str
    format: DocumentFormat
    chars: int
    revision: int
    question_count: int
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class Document:
    meta: DocumentMeta
    text: str


@dataclass(frozen=True, slots=True)
class DocumentListQuery:
    q: str | None = None
    limit: int = DEFAULT_LIMIT
    # курсор: документы строго «старше» (`updated_at`, `id`)
    before: tuple[datetime, uuid.UUID] | None = None


@dataclass(frozen=True, slots=True)
class DocumentListItem:
    meta: DocumentMeta
    snippet: str | None = None


@dataclass(frozen=True, slots=True)
class DocumentPage:
    items: list[DocumentListItem]
    next: tuple[datetime, uuid.UUID] | None


class DocumentStore(Protocol):
    """Хранилище документов; ошибки соединения с БД — 503 `database_unavailable`."""

    async def create(
        self, title: str, filename: str, format: DocumentFormat, text: str
    ) -> Document: ...
    async def get(self, did: uuid.UUID) -> Document | None: ...
    async def list(self, query: DocumentListQuery) -> DocumentPage: ...
    async def rename(self, did: uuid.UUID, title: str, filename: str) -> DocumentMeta | None: ...
    async def write_text(self, did: uuid.UUID, *, revision: int, text: str) -> DocumentMeta:
        """Заменяет текст; `revision` должен совпасть (иначе 409 `document_conflict`)."""
        ...

    async def delete(self, did: uuid.UUID) -> bool:
        """Удаляет документ вместе с вопросами к нему."""
        ...


def _format(value: str) -> DocumentFormat:
    return "text" if value == "text" else "markdown"


# --- SQL -------------------------------------------------------------------------------

# колонки меты: список и запись не читают сам текст (до AIGW_MAX_DOCUMENT_MB)
_META_COLUMNS = (
    DocumentRow.id,
    DocumentRow.title,
    DocumentRow.filename,
    DocumentRow.format,
    DocumentRow.chars,
    DocumentRow.revision,
    DocumentRow.created_at,
    DocumentRow.updated_at,
)


def _question_count() -> ColumnElement[int]:
    return (
        select(func.count())
        .select_from(ConversationRow)
        .where(ConversationRow.document_id == DocumentRow.id)
        .scalar_subquery()
    )


class SqlDocumentStore:
    """`DocumentStore` на PostgreSQL."""

    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = sessions

    def _session(self) -> AbstractAsyncContextManager[AsyncSession]:
        return session_scope(self._sessions)

    @staticmethod
    async def _meta(session: AsyncSession, did: uuid.UUID) -> DocumentMeta | None:
        row = (
            await session.execute(
                select(*_META_COLUMNS, _question_count()).where(DocumentRow.id == did)
            )
        ).one_or_none()
        return None if row is None else _meta_from(tuple(row))

    async def create(
        self, title: str, filename: str, format: DocumentFormat, text: str
    ) -> Document:
        did = uuid.uuid4()
        async with self._session() as session:
            session.add(
                DocumentRow(
                    id=did,
                    title=title,
                    filename=filename,
                    format=format,
                    text=text,
                    chars=len(text),
                    revision=0,
                )
            )
            await session.flush()
            meta = await self._meta(session, did)
            assert meta is not None
            return Document(meta=meta, text=text)

    async def get(self, did: uuid.UUID) -> Document | None:
        async with self._session() as session:
            meta = await self._meta(session, did)
            if meta is None:
                return None
            text = await session.scalar(select(DocumentRow.text).where(DocumentRow.id == did))
            return Document(meta=meta, text=text or "")

    async def list(self, query: DocumentListQuery) -> DocumentPage:
        limit = max(1, min(query.limit, MAX_LIMIT))
        snippet: ColumnElement[str | None] = literal(None)
        statement = select(*_META_COLUMNS, _question_count())
        if query.q:
            tsquery = func.websearch_to_tsquery(cast_("russian", REGCONFIG), query.q)
            head = func.left(DocumentRow.text, 1_000_000)
            in_text = func.to_tsvector(cast_("russian", REGCONFIG), head).op("@@")(tsquery)
            # фрагмент — только если слово нашлось в тексте, а не лишь в названии
            snippet = case(
                (
                    in_text,
                    func.ts_headline(
                        cast_("russian", REGCONFIG), head, tsquery, literal(SNIPPET_OPTIONS)
                    ),
                ),
                else_=literal(None),
            )
            statement = statement.where(DocumentRow.search.op("@@")(tsquery))
        statement = statement.add_columns(snippet).order_by(
            DocumentRow.updated_at.desc(), DocumentRow.id.desc()
        )
        if query.before is not None:
            at, did = query.before
            statement = statement.where(
                tuple_(DocumentRow.updated_at, DocumentRow.id) < tuple_(literal(at), literal(did))
            )
        async with self._session() as session:
            rows = (await session.execute(statement.limit(limit + 1))).all()
        items = [
            DocumentListItem(
                meta=_meta_from(tuple(row)[:-1]),
                snippet=row[-1] if isinstance(row[-1], str) else None,
            )
            for row in rows[:limit]
        ]
        last = items[-1].meta if items and len(rows) > limit else None
        return DocumentPage(items=items, next=None if last is None else (last.updated_at, last.id))

    async def rename(self, did: uuid.UUID, title: str, filename: str) -> DocumentMeta | None:
        async with self._session() as session:
            row = await session.get(DocumentRow, did, with_for_update=True)
            if row is None:
                return None
            row.title = title
            row.filename = filename
            row.updated_at = func.now()
            await session.flush()
            return await self._meta(session, did)

    async def write_text(self, did: uuid.UUID, *, revision: int, text: str) -> DocumentMeta:
        async with self._session() as session:
            # FOR UPDATE сериализует записи одного документа: вторая увидит новый revision
            current = await session.scalar(
                select(DocumentRow.revision).where(DocumentRow.id == did).with_for_update()
            )
            if current is None:
                raise document_not_found()
            if current != revision:
                raise document_conflict()
            await session.execute(
                update(DocumentRow)
                .where(DocumentRow.id == did)
                .values(text=text, chars=len(text), revision=revision + 1, updated_at=func.now())
            )
            meta = await self._meta(session, did)
            assert meta is not None
            return meta

    async def delete(self, did: uuid.UUID) -> bool:
        async with self._session() as session:
            deleted = await session.execute(
                delete(DocumentRow).where(DocumentRow.id == did).returning(DocumentRow.id)
            )
            return deleted.scalar_one_or_none() is not None


def _meta_from(row: tuple[object, ...]) -> DocumentMeta:
    did, title, filename, fmt, chars, revision, created, updated, questions = row
    assert isinstance(did, uuid.UUID)
    assert isinstance(created, datetime)
    assert isinstance(updated, datetime)
    return DocumentMeta(
        id=did,
        title=str(title),
        filename=str(filename),
        format=_format(str(fmt)),
        chars=int(str(chars)),
        revision=int(str(revision)),
        question_count=int(str(questions or 0)),
        created_at=created,
        updated_at=updated,
    )
