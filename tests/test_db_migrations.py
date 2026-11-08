"""Миграции Alembic на настоящем PostgreSQL (`pytest -m postgres`)."""

import asyncio
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

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


CONVERSATION_TABLES = {"conversations", "conversation_messages"}


async def _insert_conversation(connection: AsyncConnection, title: str = "Диалог") -> uuid.UUID:
    cid = uuid.uuid4()
    await connection.execute(
        text("INSERT INTO conversations (id, title, settings) VALUES (:id, :title, '{}')"),
        {"id": cid, "title": title},
    )
    return cid


async def test_upgrade_creates_conversation_tables(pg_engine):
    assert CONVERSATION_TABLES <= await _tables(pg_engine)


async def test_message_role_check(pg_engine):
    async with pg_engine.begin() as connection:
        cid = await _insert_conversation(connection)
    with pytest.raises(IntegrityError):
        async with pg_engine.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO conversation_messages (conversation_id, position, role, text, "
                    "status) VALUES (:id, 0, 'user', 'вопрос', 'done')"
                ),
                {"id": cid},
            )
    with pytest.raises(IntegrityError):
        async with pg_engine.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO conversation_messages (conversation_id, position, role, text) "
                    "VALUES (:id, 0, 'assistant', 'ответ без статуса')"
                ),
                {"id": cid},
            )


async def test_conversation_search_stemming(pg_engine):
    async with pg_engine.begin() as connection:
        await _insert_conversation(connection, "Котики и кошки")
        found = await connection.execute(
            text(
                "SELECT count(*) FROM conversations "
                "WHERE search @@ websearch_to_tsquery('russian', 'котик')"
            )
        )
        assert found.scalar_one() == 1


async def test_cascade_delete_messages(pg_engine):
    async with pg_engine.begin() as connection:
        cid = await _insert_conversation(connection)
        await connection.execute(
            text(
                "INSERT INTO conversation_messages (conversation_id, position, role, text) "
                "VALUES (:id, 0, 'user', 'вопрос')"
            ),
            {"id": cid},
        )
        await connection.execute(text("DELETE FROM conversations WHERE id = :id"), {"id": cid})
        left = await connection.execute(text("SELECT count(*) FROM conversation_messages"))
        assert left.scalar_one() == 0


async def test_downgrade_0001_drops_only_conversations(pg_engine, postgres_url):
    await asyncio.to_thread(downgrade, postgres_url, "0001")
    tables = await _tables(pg_engine)
    assert not CONVERSATION_TABLES & tables
    assert {"transcriptions", "transcription_results"} <= tables
    await asyncio.to_thread(migrate, postgres_url)
    assert CONVERSATION_TABLES <= await _tables(pg_engine)
