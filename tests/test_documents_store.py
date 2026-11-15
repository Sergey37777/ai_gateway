"""Хранилище документов: общее поведение фейка и SQL-реализации, плюс SQL-специфика.

SQL-варианты помечены `postgres` и по умолчанию не запускаются (`uv run pytest -m postgres`).
"""

import asyncio
import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine

from ai_gateway.db.engine import make_sessions
from ai_gateway.documents import DocumentListQuery, DocumentStore, SqlDocumentStore
from ai_gateway.errors import GatewayError
from tests.fakes import InMemoryDocumentStore

TEXT = "# Заголовок\n\nРаспознавание речи и документы."


@pytest.fixture(params=["memory", pytest.param("sql", marks=pytest.mark.postgres)])
def store(request: pytest.FixtureRequest) -> DocumentStore:
    # синхронная фикстура: async pg_engine запрашивается вне работающего цикла
    if request.param == "memory":
        return InMemoryDocumentStore()
    engine: AsyncEngine = request.getfixturevalue("pg_engine")
    return SqlDocumentStore(make_sessions(engine))


@pytest.fixture
def sql_store(pg_engine: AsyncEngine) -> SqlDocumentStore:
    return SqlDocumentStore(make_sessions(pg_engine))


async def test_create_and_get(store):
    created = await store.create("Заметки", "notes.md", "markdown", TEXT)
    meta = created.meta
    assert (meta.title, meta.filename, meta.format) == ("Заметки", "notes.md", "markdown")
    assert meta.chars == len(TEXT)
    assert (meta.revision, meta.question_count) == (0, 0)
    loaded = await store.get(meta.id)
    assert loaded is not None
    assert loaded.text == TEXT
    assert loaded.meta == meta
    assert await store.get(uuid.uuid4()) is None


async def test_write_text_bumps_revision_and_updated_at(store):
    created = await store.create("Заметки", "notes.md", "markdown", TEXT)
    meta = await store.write_text(created.meta.id, revision=0, text="новый текст")
    assert meta.revision == 1
    assert meta.chars == len("новый текст")
    assert meta.updated_at > created.meta.updated_at
    loaded = await store.get(created.meta.id)
    assert loaded is not None
    assert loaded.text == "новый текст"


async def test_write_text_conflict(store):
    created = await store.create("Заметки", "notes.md", "markdown", TEXT)
    with pytest.raises(GatewayError) as caught:
        await store.write_text(created.meta.id, revision=3, text="x")
    assert (caught.value.status_code, caught.value.code) == (409, "document_conflict")
    loaded = await store.get(created.meta.id)
    assert loaded is not None
    assert (loaded.text, loaded.meta.revision) == (TEXT, 0)


async def test_write_text_not_found(store):
    with pytest.raises(GatewayError) as caught:
        await store.write_text(uuid.uuid4(), revision=0, text="x")
    assert (caught.value.status_code, caught.value.code) == (404, "document_not_found")


async def test_rename_updates_updated_at_not_revision(store):
    created = await store.create("Заметки", "notes.md", "markdown", TEXT)
    meta = await store.rename(created.meta.id, "Итоги", "Итоги.md")
    assert meta is not None
    assert (meta.title, meta.filename, meta.revision) == ("Итоги", "Итоги.md", 0)
    assert meta.updated_at > created.meta.updated_at
    assert await store.rename(uuid.uuid4(), "x", "x.md") is None


async def test_list_order_cursor(store):
    first = await store.create("Первый", "a.md", "markdown", "a")
    second = await store.create("Второй", "b.md", "markdown", "b")
    # запись в первый поднимает его наверх
    await store.write_text(first.meta.id, revision=0, text="aa")
    page = await store.list(DocumentListQuery(limit=1))
    assert [i.meta.id for i in page.items] == [first.meta.id]
    assert page.items[0].meta.chars == 2
    assert page.next is not None
    rest = await store.list(DocumentListQuery(limit=1, before=page.next))
    assert [i.meta.id for i in rest.items] == [second.meta.id]
    assert rest.next is None


async def test_search_title_and_text(store):
    by_title = await store.create("Котики", "a.md", "markdown", "Привет")
    by_text = await store.create("Разное", "b.md", "markdown", "Расскажи про котиков")
    await store.create("Собаки", "c.md", "markdown", "Гав")
    page = await store.list(DocumentListQuery(q="котик"))
    found = {i.meta.id: i.snippet for i in page.items}
    assert set(found) == {by_title.meta.id, by_text.meta.id}
    assert found[by_title.meta.id] is None
    assert found[by_text.meta.id] is not None


async def test_delete(store):
    created = await store.create("Заметки", "notes.md", "markdown", TEXT)
    assert await store.delete(created.meta.id) is True
    assert await store.get(created.meta.id) is None
    assert await store.delete(created.meta.id) is False


@pytest.mark.postgres
async def test_search_stemming_and_snippet(sql_store):
    created = await sql_store.create("Животные", "a.md", "markdown", "У меня живёт кошка Муся")
    page = await sql_store.list(DocumentListQuery(q="кошками"))
    assert [i.meta.id for i in page.items] == [created.meta.id]
    assert page.items[0].snippet is not None
    assert "«кошка»" in page.items[0].snippet


@pytest.mark.postgres
async def test_parallel_writes_one_conflict(sql_store):
    created = await sql_store.create("Заметки", "notes.md", "markdown", TEXT)
    results = await asyncio.gather(
        sql_store.write_text(created.meta.id, revision=0, text="А"),
        sql_store.write_text(created.meta.id, revision=0, text="Б"),
        return_exceptions=True,
    )
    errors = [r for r in results if isinstance(r, GatewayError)]
    assert [e.code for e in errors] == ["document_conflict"]
    loaded = await sql_store.get(created.meta.id)
    assert loaded is not None
    assert loaded.meta.revision == 1


@pytest.mark.postgres
async def test_document_at_limit(sql_store):
    # 5 МиБ русского текста: tsvector индексирует начало, документ сохраняется целиком
    words = ["распознавание", "речи", "документ", "модель", "вопрос", "ответ", "раздел"]
    parts: list[str] = []
    size = 0
    index = 0
    while size < 5 * 1024 * 1024 - 64:
        word = f"{words[index % len(words)]}{index % 997}"
        parts.append(word)
        size += len(word.encode()) + 1
        index += 1
    text = "уникальноеначало " + " ".join(parts)
    text = text.encode()[: 5 * 1024 * 1024].decode(errors="ignore")
    created = await sql_store.create("Большой", "big.md", "markdown", text)
    loaded = await sql_store.get(created.meta.id)
    assert loaded is not None
    assert loaded.text == text
    page = await sql_store.list(DocumentListQuery(q="уникальноеначало"))
    assert [i.meta.id for i in page.items] == [created.meta.id]
