"""Общее для хранилищ на SQLAlchemy: сессия с переводом ошибок соединения и позиция курсора."""

import base64
import binascii
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime

from sqlalchemy.exc import InterfaceError, OperationalError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ai_gateway.errors import GatewayError, database_unavailable

# опции ts_headline для фрагмента найденного текста в списках истории
SNIPPET_OPTIONS = "MaxWords=18, MinWords=8, StartSel=«, StopSel=»"


@asynccontextmanager
async def session_scope(sessions: async_sessionmaker[AsyncSession]) -> AsyncIterator[AsyncSession]:
    """Сессия в транзакции; ошибки соединения с БД → 503 `database_unavailable`."""
    try:
        async with sessions() as session, session.begin():
            yield session
    except (OperationalError, InterfaceError) as exc:
        raise database_unavailable() from exc


def encode_position(at: datetime, pid: uuid.UUID) -> str:
    """Курсор списка: записи строго «старше» (`at`, `pid`) — base64url без `=`."""
    raw = f"{at.isoformat()}|{pid}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_position(value: str) -> tuple[datetime, uuid.UUID]:
    """Курсор из `?before=`; битый — 400 с `param="before"`."""
    try:
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)).decode()
        stamp, _, pid = raw.partition("|")
        at = datetime.fromisoformat(stamp)
        if at.tzinfo is None:
            raise ValueError("время без часового пояса")
        return at, uuid.UUID(pid)
    except (ValueError, binascii.Error, UnicodeDecodeError) as exc:
        raise GatewayError(
            400, "invalid_request_error", "Некорректный курсор", param="before"
        ) from exc
