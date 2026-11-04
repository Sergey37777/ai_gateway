"""Хранилище распознаваний: протокол, записи и реализация на SQLAlchemy (PostgreSQL).

ORM-строки наружу не выходят — только frozen dataclass'ы. Переходы статусов — условные
`UPDATE … WHERE status IN (…)`: поздний `finish` не воскресит удалённую или отменённую запись.
"""

import asyncio
import base64
import binascii
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Literal, Protocol, TypeGuard, get_args

from sqlalchemy import cast, delete, func, literal, select, text, tuple_, update
from sqlalchemy.dialects.postgresql import REGCONFIG
from sqlalchemy.exc import InterfaceError, OperationalError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ai_gateway.backends.base import Segment, TranscriptionResult, Word
from ai_gateway.db.models import TranscriptionResultRow, TranscriptionRow
from ai_gateway.errors import GatewayError, database_unavailable

Status = Literal["queued", "running", "done", "failed", "cancelled"]
Source = Literal["ui", "api"]
STATUSES: tuple[Status, ...] = get_args(Status)
ACTIVE: tuple[Status, ...] = ("queued", "running")
DEFAULT_LIMIT = 30
MAX_LIMIT = 100
SNIPPET_OPTIONS = "MaxWords=18, MinWords=8, StartSel=«, StopSel=»"


def is_status(value: str) -> TypeGuard[Status]:
    return value in STATUSES


@dataclass(frozen=True, slots=True)
class TranscriptionParams:
    """Параметры распознавания; `model` — имя после `registry.resolve`, не алиас."""

    model: str
    language: str | None
    prompt: str | None
    temperature: float
    word_timestamps: bool


@dataclass(frozen=True, slots=True)
class NewTranscription:
    id: uuid.UUID
    status: Literal["queued", "running"]
    source: Source
    title: str
    filename: str
    params: TranscriptionParams
    upload_path: str


@dataclass(frozen=True, slots=True)
class TranscriptionRecord:
    """Запись без результата (сегменты и слова — `get_result`)."""

    id: uuid.UUID
    status: Status
    source: Source
    title: str
    filename: str
    params: TranscriptionParams
    upload_path: str | None
    audio_path: str | None
    audio_bytes: int | None
    language: str | None
    duration: float | None
    text: str | None
    error_code: str | None
    error_message: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


@dataclass(frozen=True, slots=True)
class Cursor:
    """Позиция в истории: записи строго старше (`created_at`, `id`)."""

    created_at: datetime
    id: uuid.UUID


def encode_cursor(cursor: Cursor) -> str:
    raw = f"{cursor.created_at.isoformat()}|{cursor.id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(value: str) -> Cursor:
    """Курсор из `?before=`; битый — 400 с `param="before"`."""
    try:
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)).decode()
        stamp, _, tid = raw.partition("|")
        created_at = datetime.fromisoformat(stamp)
        if created_at.tzinfo is None:
            raise ValueError("время без часового пояса")
        return Cursor(created_at=created_at, id=uuid.UUID(tid))
    except (ValueError, binascii.Error, UnicodeDecodeError) as exc:
        raise GatewayError(
            400, "invalid_request_error", "Некорректный курсор", param="before"
        ) from exc


@dataclass(frozen=True, slots=True)
class ListQuery:
    q: str | None = None
    status: Status | None = None
    limit: int = DEFAULT_LIMIT
    before: Cursor | None = None


@dataclass(frozen=True, slots=True)
class ListItem:
    record: TranscriptionRecord
    # фрагмент текста с выделенными «совпадениями» — только при поиске
    snippet: str | None = None


@dataclass(frozen=True, slots=True)
class Page:
    items: list[ListItem]
    next: Cursor | None


class TranscriptionStore(Protocol):
    """Состояние очереди и история; все методы асинхронные."""

    async def create(self, new: NewTranscription) -> TranscriptionRecord: ...
    async def get(self, tid: uuid.UUID) -> TranscriptionRecord | None: ...
    async def get_result(self, tid: uuid.UUID) -> TranscriptionResult | None: ...
    async def list(self, query: ListQuery) -> Page: ...
    async def claim_next(self) -> TranscriptionRecord | None: ...
    async def finish(
        self,
        tid: uuid.UUID,
        result: TranscriptionResult,
        audio_path: str | None,
        audio_bytes: int | None,
    ) -> None: ...
    async def fail(
        self, tid: uuid.UUID, code: str, message: str, *, keep_upload: bool = True
    ) -> None: ...
    async def cancel(self, tid: uuid.UUID, *, keep_upload: bool = True) -> None: ...
    async def requeue(self, tid: uuid.UUID) -> TranscriptionRecord | None: ...
    async def requeue_running(self) -> int: ...
    async def rename(self, tid: uuid.UUID, title: str) -> TranscriptionRecord | None: ...
    async def delete(self, tid: uuid.UUID) -> TranscriptionRecord | None: ...
    async def queue_position(self, tid: uuid.UUID) -> int | None: ...
    async def counts(self) -> dict[Status, int]: ...
    async def file_paths(self) -> set[str]: ...
    async def ping(self) -> bool: ...


# --- JSON ⇄ dataclass'ы результата ------------------------------------------------------


def options_json(params: TranscriptionParams) -> dict[str, object]:
    return {
        "language": params.language,
        "prompt": params.prompt,
        "temperature": params.temperature,
        "word_timestamps": params.word_timestamps,
    }


def _str_or_none(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _number(data: dict[str, object], key: str) -> float:
    value = data.get(key)
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError(f"поле {key} не число")
    return float(value)


def params_from_json(model: str, data: dict[str, object]) -> TranscriptionParams:
    temperature = data.get("temperature")
    return TranscriptionParams(
        model=model,
        language=_str_or_none(data.get("language")),
        prompt=_str_or_none(data.get("prompt")),
        temperature=float(temperature) if isinstance(temperature, int | float) else 0.0,
        word_timestamps=data.get("word_timestamps") is True,
    )


def segment_from_json(data: dict[str, object]) -> Segment:
    tokens = data.get("tokens")
    return Segment(
        id=int(_number(data, "id")),
        start=_number(data, "start"),
        end=_number(data, "end"),
        text=str(data.get("text", "")),
        avg_logprob=_number(data, "avg_logprob"),
        compression_ratio=_number(data, "compression_ratio"),
        no_speech_prob=_number(data, "no_speech_prob"),
        temperature=_number(data, "temperature"),
        seek=int(_number(data, "seek")),
        tokens=[int(t) for t in tokens if isinstance(t, int)] if isinstance(tokens, list) else [],
    )


def word_from_json(data: dict[str, object]) -> Word:
    return Word(
        word=str(data.get("word", "")), start=_number(data, "start"), end=_number(data, "end")
    )


def _record(row: TranscriptionRow) -> TranscriptionRecord:
    status, source = row.status, row.source
    if not is_status(status) or source not in ("ui", "api"):
        raise ValueError(f"Некорректная запись {row.id}: {status}/{source}")
    return TranscriptionRecord(
        id=row.id,
        status=status,
        source="ui" if source == "ui" else "api",
        title=row.title,
        filename=row.filename,
        params=params_from_json(row.model, row.options),
        upload_path=row.upload_path,
        audio_path=row.audio_path,
        audio_bytes=row.audio_bytes,
        language=row.language,
        duration=row.duration,
        text=row.text,
        error_code=row.error_code,
        error_message=row.error_message,
        created_at=row.created_at,
        started_at=row.started_at,
        finished_at=row.finished_at,
    )


# --- SQL -------------------------------------------------------------------------------


class SqlTranscriptionStore:
    """`TranscriptionStore` на PostgreSQL; ошибки соединения → 503 `database_unavailable`."""

    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = sessions

    @asynccontextmanager
    async def _session(self) -> AsyncIterator[AsyncSession]:
        try:
            async with self._sessions() as session, session.begin():
                yield session
        except (OperationalError, InterfaceError) as exc:
            raise database_unavailable() from exc

    async def create(self, new: NewTranscription) -> TranscriptionRecord:
        async with self._session() as session:
            row = TranscriptionRow(
                id=new.id,
                status=new.status,
                source=new.source,
                title=new.title,
                filename=new.filename,
                model=new.params.model,
                options=options_json(new.params),
                upload_path=new.upload_path,
                started_at=datetime.now(UTC) if new.status == "running" else None,
            )
            session.add(row)
            await session.flush()
            await session.refresh(row)
            return _record(row)

    async def get(self, tid: uuid.UUID) -> TranscriptionRecord | None:
        async with self._session() as session:
            row = await session.get(TranscriptionRow, tid)
            return None if row is None else _record(row)

    async def get_result(self, tid: uuid.UUID) -> TranscriptionResult | None:
        async with self._session() as session:
            found = (
                await session.execute(
                    select(TranscriptionRow, TranscriptionResultRow)
                    .join(TranscriptionResultRow)
                    .where(TranscriptionRow.id == tid)
                )
            ).one_or_none()
            if found is None:
                return None
            row, result = found
            return TranscriptionResult(
                text=row.text or "",
                language=row.language or "",
                duration=row.duration or 0.0,
                segments=[segment_from_json(s) for s in result.segments],
                words=None if result.words is None else [word_from_json(w) for w in result.words],
            )

    async def list(self, query: ListQuery) -> Page:
        limit = max(1, min(query.limit, MAX_LIMIT))
        russian = cast("russian", REGCONFIG)
        tsquery = func.websearch_to_tsquery(russian, query.q) if query.q else None
        snippet = (
            func.ts_headline(
                russian,
                func.coalesce(TranscriptionRow.text, ""),
                tsquery,
                literal(SNIPPET_OPTIONS),
            )
            if tsquery is not None
            else literal(None)
        )
        statement = select(TranscriptionRow, snippet).order_by(
            TranscriptionRow.created_at.desc(), TranscriptionRow.id.desc()
        )
        if tsquery is not None:
            statement = statement.where(TranscriptionRow.search.op("@@")(tsquery))
        if query.status is not None:
            statement = statement.where(TranscriptionRow.status == query.status)
        if query.before is not None:
            statement = statement.where(
                tuple_(TranscriptionRow.created_at, TranscriptionRow.id)
                < tuple_(literal(query.before.created_at), literal(query.before.id))
            )
        async with self._session() as session:
            rows = (await session.execute(statement.limit(limit + 1))).all()
        items = [
            ListItem(record=_record(row), snippet=_str_or_none(found))
            for row, found in rows[:limit]
        ]
        last = items[-1].record if items else None
        has_more = len(rows) > limit and last is not None
        return Page(
            items=items,
            next=Cursor(created_at=last.created_at, id=last.id) if has_more and last else None,
        )

    async def claim_next(self) -> TranscriptionRecord | None:
        oldest = (
            select(TranscriptionRow.id)
            .where(TranscriptionRow.status == "queued")
            .order_by(TranscriptionRow.created_at, TranscriptionRow.id)
            .limit(1)
            .with_for_update(skip_locked=True)
            .scalar_subquery()
        )
        async with self._session() as session:
            row = (
                await session.execute(
                    update(TranscriptionRow)
                    .where(TranscriptionRow.id == oldest)
                    .values(status="running", started_at=func.now())
                    .returning(TranscriptionRow)
                )
            ).scalar_one_or_none()
            return None if row is None else _record(row)

    async def finish(
        self,
        tid: uuid.UUID,
        result: TranscriptionResult,
        audio_path: str | None,
        audio_bytes: int | None,
    ) -> None:
        async with self._session() as session:
            updated = await session.execute(
                update(TranscriptionRow)
                .where(TranscriptionRow.id == tid, TranscriptionRow.status == "running")
                .values(
                    status="done",
                    upload_path=None,
                    audio_path=audio_path,
                    audio_bytes=audio_bytes,
                    language=result.language,
                    duration=result.duration,
                    text=result.text,
                    finished_at=func.now(),
                )
                .returning(TranscriptionRow.id)
            )
            if updated.scalar_one_or_none() is None:
                return
            session.add(
                TranscriptionResultRow(
                    transcription_id=tid,
                    segments=[asdict(s) for s in result.segments],
                    words=None if result.words is None else [asdict(w) for w in result.words],
                )
            )

    async def _set_final(
        self,
        tid: uuid.UUID,
        status: Status,
        code: str | None,
        message: str | None,
        *,
        keep_upload: bool,
    ) -> None:
        values: dict[str, object] = {
            "status": status,
            "error_code": code,
            "error_message": message,
            "finished_at": func.now(),
        }
        if not keep_upload:
            values["upload_path"] = None
        async with self._session() as session:
            await session.execute(
                update(TranscriptionRow)
                .where(TranscriptionRow.id == tid, TranscriptionRow.status.in_(ACTIVE))
                .values(values)
            )

    async def fail(
        self, tid: uuid.UUID, code: str, message: str, *, keep_upload: bool = True
    ) -> None:
        """`keep_upload=False` — повтор бессмыслен (битый файл, вызов SDK): путь стирается."""
        await self._set_final(tid, "failed", code, message, keep_upload=keep_upload)

    async def cancel(self, tid: uuid.UUID, *, keep_upload: bool = True) -> None:
        await self._set_final(tid, "cancelled", None, None, keep_upload=keep_upload)

    async def requeue(self, tid: uuid.UUID) -> TranscriptionRecord | None:
        async with self._session() as session:
            row = (
                await session.execute(
                    update(TranscriptionRow)
                    .where(
                        TranscriptionRow.id == tid,
                        TranscriptionRow.status.in_(("failed", "cancelled")),
                        TranscriptionRow.upload_path.is_not(None),
                    )
                    .values(
                        status="queued",
                        error_code=None,
                        error_message=None,
                        started_at=None,
                        finished_at=None,
                    )
                    .returning(TranscriptionRow)
                )
            ).scalar_one_or_none()
            return None if row is None else _record(row)

    async def requeue_running(self) -> int:
        async with self._session() as session:
            result = await session.execute(
                update(TranscriptionRow)
                .where(TranscriptionRow.status == "running")
                .values(status="queued", started_at=None)
                .returning(TranscriptionRow.id)
            )
            return len(result.all())

    async def rename(self, tid: uuid.UUID, title: str) -> TranscriptionRecord | None:
        async with self._session() as session:
            row = (
                await session.execute(
                    update(TranscriptionRow)
                    .where(TranscriptionRow.id == tid)
                    .values(title=title)
                    .returning(TranscriptionRow)
                )
            ).scalar_one_or_none()
            return None if row is None else _record(row)

    async def delete(self, tid: uuid.UUID) -> TranscriptionRecord | None:
        async with self._session() as session:
            row = (
                await session.execute(
                    delete(TranscriptionRow)
                    .where(TranscriptionRow.id == tid)
                    .returning(TranscriptionRow)
                )
            ).scalar_one_or_none()
            return None if row is None else _record(row)

    async def queue_position(self, tid: uuid.UUID) -> int | None:
        async with self._session() as session:
            row = await session.get(TranscriptionRow, tid)
            if row is None or row.status != "queued":
                return None
            ahead = await session.scalar(
                select(func.count())
                .select_from(TranscriptionRow)
                .where(
                    TranscriptionRow.status == "queued",
                    tuple_(TranscriptionRow.created_at, TranscriptionRow.id)
                    < tuple_(literal(row.created_at), literal(row.id)),
                )
            )
            return 1 + (ahead or 0)

    async def counts(self) -> dict[Status, int]:
        async with self._session() as session:
            rows = await session.execute(
                select(TranscriptionRow.status, func.count()).group_by(TranscriptionRow.status)
            )
            return {status: count for status, count in rows if is_status(status)}

    async def file_paths(self) -> set[str]:
        async with self._session() as session:
            rows = await session.execute(
                select(TranscriptionRow.upload_path, TranscriptionRow.audio_path)
            )
            return {path for pair in rows for path in pair if path is not None}

    async def ping(self) -> bool:
        try:
            async with asyncio.timeout(2.0), self._sessions() as session:
                await session.execute(text("SELECT 1"))
        except Exception:  # любая ошибка соединения — «недоступна»
            return False
        return True
