"""Окружение Alembic: async-движок; запускается из `migrate()` в отдельном потоке."""

import asyncio
import os

from alembic import context
from sqlalchemy import Connection
from sqlalchemy.ext.asyncio import create_async_engine

from ai_gateway.db.models import Base

config = context.config
target_metadata = Base.metadata


def _run(connection: Connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata)
    with context.begin_transaction():
        context.run_migrations()


async def _run_async() -> None:
    url = config.get_main_option("sqlalchemy.url")
    # CLI (`uv run alembic …` с alembic.ini) уважает AIGW_DATABASE_URL, как и шлюз
    if config.config_file_name is not None:
        url = os.environ.get("AIGW_DATABASE_URL", url)
    if url is None:
        raise RuntimeError("Не задан sqlalchemy.url")
    engine = create_async_engine(url)
    try:
        async with engine.connect() as connection:
            await connection.run_sync(_run)
            await connection.commit()
    finally:
        await engine.dispose()


if context.is_offline_mode():
    raise RuntimeError("Офлайн-режим Alembic не поддерживается")
asyncio.run(_run_async())
