"""Движок SQLAlchemy (async, psycopg 3) и применение миграций Alembic."""

import asyncio
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from sqlalchemy.ext.asyncio import create_async_engine as _create_async_engine

MIGRATIONS_DIR = Path(__file__).with_name("migrations")
PING_TIMEOUT = 2.0


def create_engine(url: str) -> AsyncEngine:
    """Пул соединений; `pool_pre_ping` переживает перезапуск PostgreSQL."""
    return _create_async_engine(url, pool_pre_ping=True)


def make_sessions(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


def _alembic_config(url: str) -> Config:
    # образ ставит пакет не-editable: alembic.ini в рантайме нет, конфиг собирается здесь
    config = Config()
    config.set_main_option("script_location", str(MIGRATIONS_DIR))
    config.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    return config


def migrate(url: str) -> None:
    """`alembic upgrade head`; блокирующий — вызывать из потока (env.py крутит свой цикл)."""
    command.upgrade(_alembic_config(url), "head")


def downgrade(url: str, revision: str) -> None:
    """`alembic downgrade <revision>` (тесты миграций)."""
    command.downgrade(_alembic_config(url), revision)


async def ping(engine: AsyncEngine) -> bool:
    """Отвечает ли БД на `SELECT 1` за `PING_TIMEOUT` секунд."""
    try:
        async with asyncio.timeout(PING_TIMEOUT):
            async with engine.connect() as connection:
                await connection.execute(text("SELECT 1"))
    except Exception:  # любая ошибка соединения — «недоступна»
        return False
    return True
