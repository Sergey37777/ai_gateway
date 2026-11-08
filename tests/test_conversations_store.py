"""Хранилище диалогов: общее поведение фейка и SQL-реализации, плюс SQL-специфика.

SQL-варианты помечены `postgres` и по умолчанию не запускаются (`uv run pytest -m postgres`).
"""

import asyncio
import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine

from ai_gateway.conversations import (
    AssistantMessage,
    ChatSettings,
    ConversationStore,
    ImagePart,
    ListQuery,
    SqlConversationStore,
    Usage,
    UserMessage,
)
from ai_gateway.db.engine import make_sessions
from ai_gateway.errors import GatewayError
from tests.fakes import InMemoryConversationStore

SETTINGS = ChatSettings(
    model="qwen3-0.6b",
    system_prompt="Отвечай кратко",
    temperature=0.7,
    max_tokens=None,
    reasoning_effort="low",
)
IMAGE = ImagePart(name="cat.png", data_url="data:image/png;base64,iVBORw0KGgo=")


def question(text: str = "Что на картинке?", *, images: bool = False) -> UserMessage:
    return UserMessage(text=text, images=(IMAGE,) if images else ())


def answer(text: str = "Кот.", *, status: str = "done") -> AssistantMessage:
    return AssistantMessage(
        text=text,
        reasoning="думаю",
        status="error" if status == "error" else "stopped" if status == "stopped" else "done",
        error="сломалось" if status == "error" else None,
        usage=Usage(prompt_tokens=10, completion_tokens=3),
        model="qwen3-0.6b",
    )


@pytest.fixture(params=["memory", pytest.param("sql", marks=pytest.mark.postgres)])
def store(request: pytest.FixtureRequest) -> ConversationStore:
    # синхронная фикстура: async pg_engine запрашивается вне работающего цикла
    if request.param == "memory":
        return InMemoryConversationStore()
    engine: AsyncEngine = request.getfixturevalue("pg_engine")
    return SqlConversationStore(make_sessions(engine))


@pytest.fixture
def sql_store(pg_engine: AsyncEngine) -> SqlConversationStore:
    return SqlConversationStore(make_sessions(pg_engine))


async def test_create_and_get(store):
    created = await store.create("Кот", SETTINGS, [question(images=True), answer()])
    assert created.meta.revision == 0
    assert created.meta.message_count == 2
    assert created.meta.settings == SETTINGS
    loaded = await store.get(created.meta.id)
    assert loaded is not None
    assert loaded.messages == (question(images=True), answer())
    assert loaded.meta == created.meta
    assert await store.get(uuid.uuid4()) is None


async def test_replace_tail_append_truncate_replace(store):
    created = await store.create("Кот", SETTINGS, [question()])
    cid = created.meta.id
    appended = await store.replace_tail(cid, revision=0, start=1, messages=[answer()])
    assert appended.revision == 1
    assert appended.message_count == 2
    assert appended.updated_at > created.meta.updated_at
    await store.replace_tail(cid, revision=1, start=2, messages=[question("Ещё"), answer("Пёс")])
    replaced = await store.replace_tail(cid, revision=2, start=1, messages=[answer("Новый")])
    assert replaced.revision == 3
    loaded = await store.get(cid)
    assert loaded is not None
    assert loaded.messages == (question(), answer("Новый"))


async def test_replace_tail_conflict(store):
    created = await store.create("Кот", SETTINGS, [question()])
    with pytest.raises(GatewayError) as caught:
        await store.replace_tail(created.meta.id, revision=5, start=1, messages=[answer()])
    assert caught.value.status_code == 409
    assert caught.value.code == "conversation_conflict"
    loaded = await store.get(created.meta.id)
    assert loaded is not None
    assert loaded.meta.revision == 0
    assert loaded.messages == (question(),)


async def test_replace_tail_from_out_of_range(store):
    created = await store.create("Кот", SETTINGS, [question()])
    with pytest.raises(GatewayError) as caught:
        await store.replace_tail(created.meta.id, revision=0, start=2, messages=[answer()])
    assert caught.value.status_code == 400
    assert caught.value.param == "from"


async def test_replace_tail_not_found(store):
    with pytest.raises(GatewayError) as caught:
        await store.replace_tail(uuid.uuid4(), revision=0, start=0, messages=[])
    assert caught.value.status_code == 404
    assert caught.value.code == "conversation_not_found"


async def test_update_meta_keeps_revision_and_order(store):
    created = await store.create("Кот", SETTINGS, [question()])
    other = ChatSettings(
        model="qwen2.5vl-3b",
        system_prompt="",
        temperature=None,
        max_tokens=256,
        reasoning_effort=None,
    )
    meta = await store.update_meta(created.meta.id, title="Котики", settings=other)
    assert meta is not None
    assert (meta.title, meta.settings) == ("Котики", other)
    assert meta.revision == 0
    assert meta.updated_at == created.meta.updated_at
    assert await store.update_meta(uuid.uuid4(), title="x") is None


async def test_list_order_cursor(store):
    first = await store.create("Первый", SETTINGS, [question()])
    second = await store.create("Второй", SETTINGS, [question()])
    # запись в первый поднимает его наверх
    await store.replace_tail(first.meta.id, revision=0, start=1, messages=[answer()])
    page = await store.list(ListQuery(limit=1))
    assert [i.meta.id for i in page.items] == [first.meta.id]
    assert page.items[0].meta.message_count == 2
    assert page.next is not None
    rest = await store.list(ListQuery(limit=1, before=page.next))
    assert [i.meta.id for i in rest.items] == [second.meta.id]
    assert rest.next is None


async def test_search_title_and_messages(store):
    by_title = await store.create("Котики", SETTINGS, [question("Привет")])
    by_message = await store.create("Разное", SETTINGS, [question("Расскажи про котиков")])
    await store.create("Собаки", SETTINGS, [question("Гав")])
    page = await store.list(ListQuery(q="котик"))
    found = {i.meta.id: i.snippet for i in page.items}
    assert set(found) == {by_title.meta.id, by_message.meta.id}
    assert found[by_title.meta.id] is None
    assert found[by_message.meta.id] is not None


async def test_delete(store):
    created = await store.create("Кот", SETTINGS, [question()])
    assert await store.delete(created.meta.id) is True
    assert await store.get(created.meta.id) is None
    assert await store.delete(created.meta.id) is False


@pytest.mark.postgres
async def test_search_stemming_and_snippet(sql_store):
    created = await sql_store.create(
        "Животные", SETTINGS, [question("Привет"), answer("У меня живёт кошка по имени Муся")]
    )
    page = await sql_store.list(ListQuery(q="кошками"))
    assert [i.meta.id for i in page.items] == [created.meta.id]
    assert page.items[0].snippet is not None
    assert "«кошка»" in page.items[0].snippet


@pytest.mark.postgres
@pytest.mark.parametrize("q", ['"кот" -пёс', '"', "-", "кот OR"])
async def test_search_special_characters(sql_store, q):
    await sql_store.create("Кот", SETTINGS, [question("кот")])
    await sql_store.list(ListQuery(q=q))


@pytest.mark.postgres
async def test_concurrent_replace_tail_one_wins(sql_store):
    created = await sql_store.create("Кот", SETTINGS, [question()])
    results = await asyncio.gather(
        sql_store.replace_tail(created.meta.id, revision=0, start=1, messages=[answer("А")]),
        sql_store.replace_tail(created.meta.id, revision=0, start=1, messages=[answer("Б")]),
        return_exceptions=True,
    )
    errors = [r for r in results if isinstance(r, GatewayError)]
    assert len(errors) == 1
    assert errors[0].code == "conversation_conflict"
    loaded = await sql_store.get(created.meta.id)
    assert loaded is not None
    assert loaded.meta.revision == 1
    assert len(loaded.messages) == 2


@pytest.mark.postgres
async def test_replace_tail_atomic(sql_store):
    created = await sql_store.create("Кот", SETTINGS, [question(), answer()])
    # NUL в тексте PostgreSQL не принимает: вторая вставка падает после удаления хвоста
    broken = answer("плохой\x00ответ")
    with pytest.raises(Exception):  # noqa: B017 — тип ошибки драйвера не важен, важен откат
        await sql_store.replace_tail(
            created.meta.id, revision=0, start=1, messages=[answer("ок"), broken]
        )
    loaded = await sql_store.get(created.meta.id)
    assert loaded is not None
    assert loaded.meta.revision == 0
    assert loaded.messages == (question(), answer())
