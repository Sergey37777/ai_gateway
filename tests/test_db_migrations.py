"""Миграции Alembic на настоящем PostgreSQL (`pytest -m postgres`)."""

import asyncio
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from ai_gateway.db.engine import downgrade, migrate

pytestmark = pytest.mark.postgres


async def _tables(engine: AsyncEngine) -> set[str]:
    async with engine.connect() as connection:
        rows = await connection.execute(
            text("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")
        )
        return {row[0] for row in rows}


async def test_upgrade_creates_tables(pg_engine):
    assert {"transcriptions", "transcription_results", "alembic_version"} <= await _tables(
        pg_engine
    )


async def test_search_column_uses_russian_stemming(pg_engine):
    async with pg_engine.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO transcriptions (id, status, source, title, filename, model, options, "
                "text) VALUES (:id, 'done', 'ui', 'Совещание', 'a.wav', 'm', '{}', "
                "'Распознавание речи')"
            ),
            {"id": uuid.uuid4()},
        )
        found = await connection.execute(
            text(
                "SELECT count(*) FROM transcriptions "
                "WHERE search @@ websearch_to_tsquery('russian', 'распознавания')"
            )
        )
        assert found.scalar_one() == 1


async def test_downgrade_base_and_back(pg_engine, postgres_url):
    await asyncio.to_thread(downgrade, postgres_url, "base")
    assert "transcriptions" not in await _tables(pg_engine)
    await asyncio.to_thread(migrate, postgres_url)
    assert "transcriptions" in await _tables(pg_engine)
