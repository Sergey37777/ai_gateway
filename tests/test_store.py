"""Хранилище распознаваний: общее поведение фейка и SQL-реализации, плюс SQL-специфика.

SQL-варианты помечены `postgres` и по умолчанию не запускаются (`uv run pytest -m postgres`).
"""

import asyncio
import uuid
from dataclasses import replace

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine

from ai_gateway.backends.base import Word
from ai_gateway.db.engine import create_engine, make_sessions
from ai_gateway.errors import GatewayError
from ai_gateway.store import (
    ListQuery,
    NewTranscription,
    SqlTranscriptionStore,
    TranscriptionParams,
    TranscriptionStore,
    decode_cursor,
    encode_cursor,
)
from tests.fakes import InMemoryTranscriptionStore, make_result

PARAMS = TranscriptionParams(
    model="whisper-base", language=None, prompt=None, temperature=0.0, word_timestamps=True
)


def new(
    *, status: str = "queued", title: str = "a.wav", upload: str | None = None
) -> NewTranscription:
    tid = uuid.uuid4()
    return NewTranscription(
        id=tid,
        status="running" if status == "running" else "queued",
        source="ui",
        title=title,
        filename="a.wav",
        params=PARAMS,
        upload_path=upload if upload is not None else f"uploads/{tid}.wav",
    )


@pytest.fixture(params=["memory", pytest.param("sql", marks=pytest.mark.postgres)])
def store(request: pytest.FixtureRequest) -> TranscriptionStore:
    # синхронная фикстура: async pg_engine запрашивается вне работающего цикла
    if request.param == "memory":
        return InMemoryTranscriptionStore()
    engine: AsyncEngine = request.getfixturevalue("pg_engine")
    return SqlTranscriptionStore(make_sessions(engine))


async def test_create_and_get(store):
    created = await store.create(new(title="Совещание"))
    assert created.status == "queued"
    assert created.title == "Совещание"
    assert created.params == PARAMS
    assert created.started_at is None
    assert await store.get(created.id) == created
    assert await store.get(uuid.uuid4()) is None


async def test_create_running_sets_started(store):
    created = await store.create(new(status="running"))
    assert created.status == "running"
    assert created.started_at is not None


async def test_claim_next_fifo_and_marks_running(store):
    first = await store.create(new())
    second = await store.create(new())
    claimed = await store.claim_next()
    assert claimed is not None
    assert claimed.id == first.id
    assert claimed.status == "running"
    assert claimed.started_at is not None
    again = await store.claim_next()
    assert again is not None and again.id == second.id
    assert await store.claim_next() is None


async def test_finish_stores_result_and_clears_upload(store):
    record = await store.create(new(status="running"))
    words = [Word(word=" привет", start=0.0, end=0.5)]
    result = replace(make_result("привет мир"), words=words)
    await store.finish(record.id, result, "audio/x.webm", 123)
    done = await store.get(record.id)
    assert done is not None
    assert done.status == "done"
    assert done.upload_path is None
    assert (done.audio_path, done.audio_bytes) == ("audio/x.webm", 123)
    assert (done.text, done.language, done.duration) == ("привет мир", "ru", 1.0)
    assert done.finished_at is not None
    assert await store.get_result(record.id) == result


async def test_get_result_without_words(store):
    record = await store.create(new(status="running"))
    await store.finish(record.id, make_result(), None, None)
    stored = await store.get_result(record.id)
    assert stored is not None and stored.words is None
    assert await store.get_result(uuid.uuid4()) is None


async def test_finish_after_delete_is_noop(store):
    record = await store.create(new(status="running"))
    await store.delete(record.id)
    await store.finish(record.id, make_result(), None, None)
    assert await store.get(record.id) is None
    assert await store.get_result(record.id) is None


async def test_finish_after_cancel_keeps_cancelled(store):
    record = await store.create(new(status="running"))
    await store.cancel(record.id)
    await store.finish(record.id, make_result(), None, None)
    cancelled = await store.get(record.id)
    assert cancelled is not None and cancelled.status == "cancelled"


async def test_fail_and_requeue(store):
    record = await store.create(new(status="running"))
    await store.fail(record.id, "model_unavailable", "Нет памяти")
    failed = await store.get(record.id)
    assert failed is not None
    assert (failed.status, failed.error_code, failed.error_message) == (
        "failed",
        "model_unavailable",
        "Нет памяти",
    )
    requeued = await store.requeue(record.id)
    assert requeued is not None
    assert (requeued.status, requeued.error_code, requeued.error_message) == ("queued", None, None)
    assert requeued.started_at is None and requeued.finished_at is None


async def test_requeue_not_allowed(store):
    record = await store.create(new(status="running"))
    await store.finish(record.id, make_result(), None, None)
    assert await store.requeue(record.id) is None  # done — нельзя
    queued = await store.create(new())
    assert await store.requeue(queued.id) is None  # уже в очереди


async def test_requeue_running(store):
    a = await store.create(new(status="running"))
    await store.create(new())
    assert await store.requeue_running() == 1
    again = await store.get(a.id)
    assert again is not None and again.status == "queued" and again.started_at is None


async def test_queue_position(store):
    a = await store.create(new())
    b = await store.create(new())
    running = await store.create(new(status="running"))
    assert await store.queue_position(a.id) == 1
    assert await store.queue_position(b.id) == 2
    assert await store.queue_position(running.id) is None
    assert await store.queue_position(uuid.uuid4()) is None


async def test_list_cursor_pages(store):
    for i in range(35):
        await store.create(new(title=f"r{i}"))
    first = await store.list(ListQuery())
    assert len(first.items) == 30
    assert first.items[0].record.title == "r34"  # новые — первыми
    assert first.next is not None
    second = await store.list(ListQuery(before=first.next))
    assert [item.record.title for item in second.items] == [f"r{i}" for i in range(4, -1, -1)]
    assert second.next is None


async def test_list_status_filter_and_limit(store):
    await store.create(new())
    running = await store.create(new(status="running"))
    page = await store.list(ListQuery(status="running"))
    assert [item.record.id for item in page.items] == [running.id]
    limited = await store.list(ListQuery(limit=1))
    assert len(limited.items) == 1 and limited.next is not None


async def test_rename(store):
    record = await store.create(new())
    renamed = await store.rename(record.id, "Новое имя")
    assert renamed is not None and renamed.title == "Новое имя"
    assert await store.rename(uuid.uuid4(), "x") is None


async def test_delete_returns_record(store):
    record = await store.create(new())
    deleted = await store.delete(record.id)
    assert deleted is not None and deleted.id == record.id
    assert await store.delete(record.id) is None


async def test_counts(store):
    await store.create(new())
    await store.create(new())
    await store.create(new(status="running"))
    counts = await store.counts()
    assert counts["queued"] == 2
    assert counts["running"] == 1
    assert counts.get("done", 0) == 0


async def test_file_paths(store):
    a = await store.create(new(status="running", upload="uploads/a.wav"))
    await store.finish(a.id, make_result(), "audio/a.webm", 1)
    await store.create(new(upload="uploads/b.wav"))
    assert await store.file_paths() == {"audio/a.webm", "uploads/b.wav"}


async def test_ping(store):
    assert await store.ping() is True


def test_cursor_roundtrip_and_garbage():
    from datetime import UTC, datetime

    from ai_gateway.store import Cursor

    cursor = Cursor(created_at=datetime(2026, 11, 4, 18, 2, tzinfo=UTC), id=uuid.uuid4())
    assert decode_cursor(encode_cursor(cursor)) == cursor
    with pytest.raises(GatewayError) as info:
        decode_cursor("не-курсор")
    assert info.value.status_code == 400
    assert info.value.param == "before"


# --- только PostgreSQL -------------------------------------------------------------------


@pytest.fixture
def sql_store(pg_engine: AsyncEngine) -> SqlTranscriptionStore:
    return SqlTranscriptionStore(make_sessions(pg_engine))


@pytest.mark.postgres
async def test_search_word_form_and_snippet(sql_store):
    record = await sql_store.create(new(status="running", title="Совещание"))
    await sql_store.finish(record.id, make_result("Распознавание речи работает"), None, None)
    other = await sql_store.create(new(status="running", title="Другое"))
    await sql_store.finish(other.id, make_result("Погода хорошая"), None, None)
    page = await sql_store.list(ListQuery(q="распознавания"))
    assert [item.record.id for item in page.items] == [record.id]
    snippet = page.items[0].snippet
    assert snippet is not None and "«Распознавание»" in snippet
    by_title = await sql_store.list(ListQuery(q="совещания"))
    assert [item.record.id for item in by_title.items] == [record.id]


@pytest.mark.postgres
async def test_search_operators_do_not_fail(sql_store):
    await sql_store.create(new())
    page = await sql_store.list(ListQuery(q='"совещание" -план & | !'))
    assert page.items == []


@pytest.mark.postgres
async def test_claim_next_skip_locked(postgres_url, pg_engine):
    store = SqlTranscriptionStore(make_sessions(pg_engine))
    await store.create(new())
    other_engine = create_engine(postgres_url)
    try:
        other = SqlTranscriptionStore(make_sessions(other_engine))
        claimed = await asyncio.gather(store.claim_next(), other.claim_next())
    finally:
        await other_engine.dispose()
    assert sum(c is not None for c in claimed) == 1


async def test_database_unavailable():
    # закрытый порт: соединение отклоняется сразу
    engine = create_engine("postgresql+psycopg://aigw:aigw@127.0.0.1:9/aigw?connect_timeout=1")
    try:
        store = SqlTranscriptionStore(make_sessions(engine))
        with pytest.raises(GatewayError) as info:
            await store.get(uuid.uuid4())
        assert info.value.status_code == 503
        assert info.value.code == "database_unavailable"
        assert info.value.headers == {"Retry-After": "5"}
        assert await store.ping() is False
    finally:
        await engine.dispose()


async def test_fail_and_cancel_can_drop_upload(store):
    failed = await store.create(new(status="running"))
    await store.fail(failed.id, "invalid_audio", "не аудио", keep_upload=False)
    record = await store.get(failed.id)
    assert record is not None and record.upload_path is None
    assert await store.requeue(failed.id) is None
    cancelled = await store.create(new())
    await store.cancel(cancelled.id, keep_upload=False)
    record = await store.get(cancelled.id)
    assert record is not None and record.upload_path is None
