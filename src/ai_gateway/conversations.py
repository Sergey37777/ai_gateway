"""Диалоги чата (этап 5): записи, протокол хранилища и реализация на SQLAlchemy (PostgreSQL).

Генерация ответов идёт мимо этого модуля (`/v1/chat/completions` из браузера); UI сохраняет
готовые сообщения операцией «замена хвоста» (`replace_tail`) с проверкой `revision`.
ORM-строки наружу не выходят — только frozen dataclass'ы.
"""

import uuid
from collections.abc import Sequence
from contextlib import AbstractAsyncContextManager
from dataclasses import asdict, dataclass
from datetime import datetime
from typing import Literal, Protocol, cast, get_args

from sqlalchemy import ColumnElement, delete, exists, func, literal, or_, select, tuple_
from sqlalchemy import cast as cast_
from sqlalchemy.dialects.postgresql import REGCONFIG
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ai_gateway.db.models import ConversationMessageRow, ConversationRow
from ai_gateway.db.session import SNIPPET_OPTIONS, session_scope
from ai_gateway.errors import GatewayError, conversation_conflict, conversation_not_found

ReasoningEffort = Literal["none", "low", "medium", "high"]
AnswerStatus = Literal["done", "stopped", "error"]

MAX_TITLE = 200
DEFAULT_LIMIT = 30
MAX_LIMIT = 100


@dataclass(frozen=True, slots=True)
class ChatSettings:
    """Настройки диалога; `model` по реестру не проверяется — модель могли убрать."""

    model: str
    system_prompt: str
    temperature: float | None
    max_tokens: int | None
    reasoning_effort: ReasoningEffort | None


@dataclass(frozen=True, slots=True)
class ImagePart:
    name: str
    data_url: str


@dataclass(frozen=True, slots=True)
class Usage:
    prompt_tokens: int
    completion_tokens: int


@dataclass(frozen=True, slots=True)
class UserMessage:
    text: str
    images: tuple[ImagePart, ...]


@dataclass(frozen=True, slots=True)
class AssistantMessage:
    text: str
    reasoning: str
    status: AnswerStatus
    error: str | None
    usage: Usage | None
    model: str | None


Message = UserMessage | AssistantMessage


@dataclass(frozen=True, slots=True)
class ConversationMeta:
    id: uuid.UUID
    title: str
    settings: ChatSettings
    revision: int
    message_count: int
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class Conversation:
    meta: ConversationMeta
    messages: tuple[Message, ...]


@dataclass(frozen=True, slots=True)
class ListQuery:
    q: str | None = None
    limit: int = DEFAULT_LIMIT
    # курсор: диалоги строго «старше» (`updated_at`, `id`)
    before: tuple[datetime, uuid.UUID] | None = None


@dataclass(frozen=True, slots=True)
class ListItem:
    meta: ConversationMeta
    snippet: str | None = None


@dataclass(frozen=True, slots=True)
class Page:
    items: list[ListItem]
    next: tuple[datetime, uuid.UUID] | None


class ConversationStore(Protocol):
    """Хранилище диалогов; ошибки соединения с БД — 503 `database_unavailable`."""

    async def create(
        self, title: str, settings: ChatSettings, messages: Sequence[Message]
    ) -> Conversation: ...
    async def get(self, cid: uuid.UUID) -> Conversation | None: ...
    async def list(self, query: ListQuery) -> Page: ...
    async def update_meta(
        self,
        cid: uuid.UUID,
        *,
        title: str | None = None,
        settings: ChatSettings | None = None,
    ) -> ConversationMeta | None: ...
    async def replace_tail(
        self, cid: uuid.UUID, *, revision: int, start: int, messages: Sequence[Message]
    ) -> ConversationMeta:
        """Атомарно заменяет сообщения с позиции `start`; `revision` должен совпасть."""
        ...

    async def delete(self, cid: uuid.UUID) -> bool: ...


def from_out_of_range(count: int) -> GatewayError:
    return GatewayError(
        400,
        "invalid_request_error",
        f"Позиция from больше числа сообщений ({count})",
        param="from",
    )


# --- JSONB ------------------------------------------------------------------------------


def settings_json(settings: ChatSettings) -> dict[str, object]:
    return {
        "model": settings.model,
        "system_prompt": settings.system_prompt,
        "temperature": settings.temperature,
        "max_tokens": settings.max_tokens,
        "reasoning_effort": settings.reasoning_effort,
    }


def _effort(value: object) -> ReasoningEffort | None:
    for effort in get_args(ReasoningEffort):
        if value == effort:
            return cast(ReasoningEffort, effort)
    return None


def settings_from_json(data: dict[str, object]) -> ChatSettings:
    """Настройки из JSONB; неизвестное или битое значение — «не задано»."""
    temperature = data.get("temperature")
    max_tokens = data.get("max_tokens")
    return ChatSettings(
        model=str(data.get("model", "")),
        system_prompt=str(data.get("system_prompt", "")),
        temperature=float(temperature) if isinstance(temperature, int | float) else None,
        max_tokens=max_tokens if isinstance(max_tokens, int) else None,
        reasoning_effort=_effort(data.get("reasoning_effort")),
    )


def _int(data: dict[str, object], key: str) -> int:
    value = data.get(key)
    return value if isinstance(value, int) else 0


def _answer_status(value: str | None) -> AnswerStatus:
    if value == "stopped":
        return "stopped"
    return "error" if value == "error" else "done"


def _message(row: ConversationMessageRow) -> Message:
    if row.role == "user":
        images = tuple(
            ImagePart(name=str(i.get("name", "")), data_url=str(i.get("data_url", "")))
            for i in row.images or []
        )
        return UserMessage(text=row.text, images=images)
    usage = row.usage
    return AssistantMessage(
        text=row.text,
        reasoning=row.reasoning or "",
        status=_answer_status(row.status),
        error=row.error,
        usage=None
        if usage is None
        else Usage(
            prompt_tokens=_int(usage, "prompt_tokens"),
            completion_tokens=_int(usage, "completion_tokens"),
        ),
        model=row.model,
    )


def _message_row(cid: uuid.UUID, position: int, message: Message) -> ConversationMessageRow:
    if isinstance(message, UserMessage):
        return ConversationMessageRow(
            conversation_id=cid,
            position=position,
            role="user",
            text=message.text,
            images=[{"name": i.name, "data_url": i.data_url} for i in message.images],
        )
    return ConversationMessageRow(
        conversation_id=cid,
        position=position,
        role="assistant",
        text=message.text,
        reasoning=message.reasoning,
        status=message.status,
        error=message.error,
        usage=None if message.usage is None else asdict(message.usage),
        model=message.model,
    )


def _meta(row: ConversationRow, message_count: int) -> ConversationMeta:
    return ConversationMeta(
        id=row.id,
        title=row.title,
        settings=settings_from_json(row.settings),
        revision=row.revision,
        message_count=message_count,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


# --- SQL -------------------------------------------------------------------------------


class SqlConversationStore:
    """`ConversationStore` на PostgreSQL."""

    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = sessions

    def _session(self) -> AbstractAsyncContextManager[AsyncSession]:
        return session_scope(self._sessions)

    @staticmethod
    async def _count(session: AsyncSession, cid: uuid.UUID) -> int:
        count = await session.scalar(
            select(func.count())
            .select_from(ConversationMessageRow)
            .where(ConversationMessageRow.conversation_id == cid)
        )
        return count or 0

    async def create(
        self, title: str, settings: ChatSettings, messages: Sequence[Message]
    ) -> Conversation:
        cid = uuid.uuid4()
        async with self._session() as session:
            row = ConversationRow(id=cid, title=title, settings=settings_json(settings), revision=0)
            session.add(row)
            # диалог вставляется раньше сообщений (внешний ключ)
            await session.flush()
            session.add_all(_message_row(cid, i, m) for i, m in enumerate(messages))
            await session.flush()
            await session.refresh(row)
            return Conversation(meta=_meta(row, len(messages)), messages=tuple(messages))

    async def get(self, cid: uuid.UUID) -> Conversation | None:
        async with self._session() as session:
            row = await session.get(ConversationRow, cid)
            if row is None:
                return None
            rows = await session.scalars(
                select(ConversationMessageRow)
                .where(ConversationMessageRow.conversation_id == cid)
                .order_by(ConversationMessageRow.position)
            )
            messages = tuple(_message(m) for m in rows)
            return Conversation(meta=_meta(row, len(messages)), messages=messages)

    async def list(self, query: ListQuery) -> Page:
        limit = max(1, min(query.limit, MAX_LIMIT))
        message = ConversationMessageRow
        count = (
            select(func.count())
            .select_from(message)
            .where(message.conversation_id == ConversationRow.id)
            .scalar_subquery()
        )
        statement = select(ConversationRow, count)
        snippet: ColumnElement[str | None] = literal(None)
        if query.q:
            tsquery = func.websearch_to_tsquery(cast_("russian", REGCONFIG), query.q)
            matched = message.search.op("@@")(tsquery)
            own = message.conversation_id == ConversationRow.id
            snippet = (
                select(
                    func.ts_headline(
                        cast_("russian", REGCONFIG), message.text, tsquery, literal(SNIPPET_OPTIONS)
                    )
                )
                .where(own, matched)
                .order_by(message.position)
                .limit(1)
                .scalar_subquery()
            )
            statement = statement.where(
                or_(
                    ConversationRow.search.op("@@")(tsquery),
                    exists().where(own, matched),
                )
            )
        statement = statement.add_columns(snippet).order_by(
            ConversationRow.updated_at.desc(), ConversationRow.id.desc()
        )
        if query.before is not None:
            at, cid = query.before
            statement = statement.where(
                tuple_(ConversationRow.updated_at, ConversationRow.id)
                < tuple_(literal(at), literal(cid))
            )
        async with self._session() as session:
            rows = (await session.execute(statement.limit(limit + 1))).all()
        items = [
            ListItem(meta=_meta(row, total or 0), snippet=found if isinstance(found, str) else None)
            for row, total, found in rows[:limit]
        ]
        last = items[-1].meta if items and len(rows) > limit else None
        return Page(items=items, next=None if last is None else (last.updated_at, last.id))

    async def update_meta(
        self,
        cid: uuid.UUID,
        *,
        title: str | None = None,
        settings: ChatSettings | None = None,
    ) -> ConversationMeta | None:
        async with self._session() as session:
            row = await session.get(ConversationRow, cid, with_for_update=True)
            if row is None:
                return None
            if title is not None:
                row.title = title
            if settings is not None:
                row.settings = settings_json(settings)
            await session.flush()
            await session.refresh(row)
            return _meta(row, await self._count(session, cid))

    async def replace_tail(
        self, cid: uuid.UUID, *, revision: int, start: int, messages: Sequence[Message]
    ) -> ConversationMeta:
        async with self._session() as session:
            # FOR UPDATE сериализует записи одного диалога: вторая увидит новый revision
            row = await session.get(ConversationRow, cid, with_for_update=True)
            if row is None:
                raise conversation_not_found()
            if row.revision != revision:
                raise conversation_conflict()
            count = await self._count(session, cid)
            if start > count:
                raise from_out_of_range(count)
            await session.execute(
                delete(ConversationMessageRow).where(
                    ConversationMessageRow.conversation_id == cid,
                    ConversationMessageRow.position >= start,
                )
            )
            session.add_all(_message_row(cid, start + i, m) for i, m in enumerate(messages))
            row.revision = revision + 1
            row.updated_at = func.now()
            await session.flush()
            await session.refresh(row)
            return _meta(row, start + len(messages))

    async def delete(self, cid: uuid.UUID) -> bool:
        async with self._session() as session:
            deleted = await session.execute(
                delete(ConversationRow)
                .where(ConversationRow.id == cid)
                .returning(ConversationRow.id)
            )
            return deleted.scalar_one_or_none() is not None
