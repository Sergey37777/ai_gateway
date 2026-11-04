"""Исполнитель распознаваний и фоновый воркер (фейковые хранилище и бэкенд, без БД и моделей)."""

import asyncio
import copy
import io
import threading
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, replace
from pathlib import Path

import pytest
from starlette.datastructures import UploadFile

from ai_gateway.backends.base import Word
from ai_gateway.errors import GatewayError
from ai_gateway.files import DataDir
from ai_gateway.jobs import TranscriptionService, Worker, prepare_params
from ai_gateway.lifecycle import ModelManager
from ai_gateway.registry import ModelRegistry
from ai_gateway.store import Status, TranscriptionParams
from tests.conftest import REGISTRY_DATA
from tests.fakes import FakeTranscriptionBackend, InMemoryTranscriptionStore, make_result

PARAMS = TranscriptionParams(
    model="whisper-large-v3-turbo",
    language=None,
    prompt=None,
    temperature=0.0,
    word_timestamps=True,
)


def upload(name: str = "a.wav", data: bytes = b"RIFFdata") -> UploadFile:
    return UploadFile(io.BytesIO(data), filename=name)


def fake_encode(_src: Path, dst: Path) -> int:
    dst.write_bytes(b"opus")
    return 4


@dataclass
class Env:
    store: InMemoryTranscriptionStore
    backend: FakeTranscriptionBackend
    files: DataDir
    service: TranscriptionService
    registry: ModelRegistry
    manager: ModelManager

    async def wait_status(self, tid: uuid.UUID, status: Status, timeout: float = 3.0) -> None:
        async with asyncio.timeout(timeout):
            while (record := self.store.records.get(tid)) is None or record.status != status:
                await asyncio.sleep(0.01)


@pytest.fixture
def make_env(tmp_path: Path) -> Callable[..., Env]:
    def _make(
        backend: FakeTranscriptionBackend | None = None,
        encode: Callable[[Path, Path], int] = fake_encode,
    ) -> Env:
        fake = backend if backend is not None else FakeTranscriptionBackend()
        registry = ModelRegistry.from_dict(copy.deepcopy(REGISTRY_DATA), default_ttl=600)
        manager = ModelManager(registry.whisper_specs(), lambda _spec: fake)
        files = DataDir(tmp_path / "data")
        files.ensure()
        store = InMemoryTranscriptionStore()
        service = TranscriptionService(store, manager, files, max_upload_mb=1, encode=encode)
        return Env(store, fake, files, service, registry, manager)

    return _make


@pytest.fixture
async def worker_for() -> AsyncIterator[Callable[[Env], None]]:
    tasks: list[asyncio.Task[None]] = []

    def _start(env: Env) -> None:
        tasks.append(asyncio.create_task(Worker(env.service, env.store).run()))

    yield _start
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


async def test_submit_then_worker_done(make_env, worker_for):
    env = make_env()
    worker_for(env)
    record = await env.service.submit(upload(), PARAMS, title=None)
    assert record.status == "queued"
    assert record.title == "a.wav"
    await env.wait_status(record.id, "done")
    done = env.store.records[record.id]
    assert done.audio_path == f"audio/{record.id}.webm"
    assert env.files.resolve(done.audio_path).read_bytes() == b"opus"
    assert done.upload_path is None
    assert list((env.files.root / "uploads").iterdir()) == []
    assert env.service.progress(done) == 1.0
    assert env.backend.last_options is not None and env.backend.last_options.word_timestamps


async def test_queue_fifo_one_at_a_time(make_env, worker_for):
    gate = threading.Event()
    env = make_env(FakeTranscriptionBackend(transcribe_gate=gate))
    worker_for(env)
    first = await env.service.submit(upload(), PARAMS, title="1")
    second = await env.service.submit(upload(), PARAMS, title="2")
    await env.wait_status(first.id, "running")
    await asyncio.sleep(0.05)
    assert env.store.records[second.id].status == "queued"
    assert await env.store.queue_position(second.id) == 1
    gate.set()
    await env.wait_status(second.id, "done")


async def test_cancel_queued(make_env):
    env = make_env()
    record = await env.service.submit(upload(), PARAMS, title=None)
    cancelled = await env.service.cancel(record.id)
    assert cancelled.status == "cancelled"
    assert env.backend.transcribe_calls == 0


async def test_cancel_running(make_env, worker_for):
    gate = threading.Event()
    env = make_env(FakeTranscriptionBackend(transcribe_gate=gate))
    worker_for(env)
    record = await env.service.submit(upload(), PARAMS, title=None)
    await env.wait_status(record.id, "running")
    await asyncio.to_thread(env.backend.transcribe_started.wait, 2)
    await env.service.cancel(record.id)
    await env.wait_status(record.id, "cancelled")
    # загрузка сохранена ради «Повторить»
    cancelled = env.store.records[record.id]
    assert cancelled.upload_path is not None
    assert env.files.resolve(cancelled.upload_path).exists()


async def test_cancel_finished_is_409(make_env, worker_for):
    env = make_env()
    worker_for(env)
    record = await env.service.submit(upload(), PARAMS, title=None)
    await env.wait_status(record.id, "done")
    with pytest.raises(GatewayError) as info:
        await env.service.cancel(record.id)
    assert (info.value.status_code, info.value.code) == (409, "invalid_state")


async def test_cancel_unknown_is_404(make_env):
    env = make_env()
    with pytest.raises(GatewayError) as info:
        await env.service.cancel(uuid.uuid4())
    assert (info.value.status_code, info.value.code) == (404, "transcription_not_found")


async def test_cancel_while_waiting_for_model(make_env, worker_for):
    gate = threading.Event()
    env = make_env(FakeTranscriptionBackend(transcribe_gate=gate))
    worker_for(env)
    first = await env.service.submit(upload(), PARAMS, title=None)
    await asyncio.to_thread(env.backend.transcribe_started.wait, 2)
    sync = asyncio.create_task(env.service.run_sync(upload(), PARAMS))
    async with asyncio.timeout(2):
        while not any(r.source == "api" for r in env.store.records.values()):
            await asyncio.sleep(0.01)
    waiting = next(r for r in env.store.records.values() if r.source == "api")
    await env.service.cancel(waiting.id)
    gate.set()
    with pytest.raises(GatewayError) as info:
        await sync
    assert (info.value.status_code, info.value.code) == (409, "transcription_cancelled")
    await env.wait_status(first.id, "done")
    assert env.store.records[waiting.id].status == "cancelled"
    assert env.backend.transcribe_calls == 1


async def test_oom_marks_failed_model_unavailable(make_env, worker_for):
    env = make_env(
        FakeTranscriptionBackend(transcribe_error=RuntimeError("CUDA failed: out of memory"))
    )
    worker_for(env)
    record = await env.service.submit(upload(), PARAMS, title=None)
    await env.wait_status(record.id, "failed")
    assert env.store.records[record.id].error_code == "model_unavailable"


async def test_invalid_audio_marks_failed(make_env, worker_for):
    error = GatewayError(400, "invalid_audio", "Не удалось декодировать аудиофайл", param="file")
    env = make_env(FakeTranscriptionBackend(transcribe_error=error))
    worker_for(env)
    record = await env.service.submit(upload(), PARAMS, title=None)
    await env.wait_status(record.id, "failed")
    failed = env.store.records[record.id]
    assert (failed.error_code, failed.error_message) == (
        "invalid_audio",
        "Не удалось декодировать аудиофайл",
    )


async def test_unexpected_error_internal_error(make_env, worker_for):
    env = make_env(FakeTranscriptionBackend(transcribe_error=ValueError("boom")))
    worker_for(env)
    record = await env.service.submit(upload(), PARAMS, title=None)
    await env.wait_status(record.id, "failed")
    failed = env.store.records[record.id]
    assert (failed.error_code, failed.error_message) == (
        "internal_error",
        "Внутренняя ошибка сервера",
    )


async def test_encode_failure_done_without_audio(make_env, worker_for):
    def broken(_src: Path, _dst: Path) -> int:
        raise ValueError("нет дорожки")

    env = make_env(encode=broken)
    worker_for(env)
    record = await env.service.submit(upload(), PARAMS, title=None)
    await env.wait_status(record.id, "done")
    assert env.store.records[record.id].audio_path is None


async def test_retry_after_failure(make_env, worker_for):
    backend = FakeTranscriptionBackend(transcribe_error=RuntimeError("out of memory"))
    env = make_env(backend)
    worker_for(env)
    record = await env.service.submit(upload(), PARAMS, title=None)
    await env.wait_status(record.id, "failed")
    backend.transcribe_error = None
    retried = await env.service.retry(record.id)
    assert retried.status == "queued"
    await env.wait_status(record.id, "done")


async def test_retry_not_allowed_409(make_env):
    env = make_env()
    record = await env.service.submit(upload(), PARAMS, title=None)
    with pytest.raises(GatewayError) as info:
        await env.service.retry(record.id)
    assert (info.value.status_code, info.value.code) == (409, "invalid_state")


async def test_retry_upload_missing(make_env, worker_for):
    backend = FakeTranscriptionBackend(transcribe_error=RuntimeError("out of memory"))
    env = make_env(backend)
    worker_for(env)
    record = await env.service.submit(upload(), PARAMS, title=None)
    await env.wait_status(record.id, "failed")
    failed = env.store.records[record.id]
    assert failed.upload_path is not None
    env.files.remove(failed.upload_path)  # удалили руками
    await env.service.retry(record.id)
    await env.wait_status(record.id, "failed")
    assert env.store.records[record.id].error_code == "upload_missing"


async def test_recover_requeues_running_and_removes_orphans(make_env, worker_for):
    env = make_env()
    record = await env.service.submit(upload(), PARAMS, title=None)
    await env.store.claim_next()  # «упал» во время распознавания
    orphan = env.files.resolve("audio/orphan.webm")
    orphan.write_bytes(b"x")
    await env.service.recover()
    assert env.store.records[record.id].status == "queued"
    assert not orphan.exists()
    upload_path = env.store.records[record.id].upload_path
    assert upload_path is not None and env.files.resolve(upload_path).exists()
    worker_for(env)
    await env.wait_status(record.id, "done")


async def test_run_sync_returns_result_source_api(make_env):
    env = make_env()
    result = await env.service.run_sync(upload("call.mp3"), replace(PARAMS, word_timestamps=False))
    assert result == env.backend.result
    record = next(iter(env.store.records.values()))
    assert (record.source, record.status, record.title) == ("api", "done", "call.mp3")


async def test_run_sync_words_only_when_requested(make_env):
    words = [Word(word=" привет", start=0.0, end=0.5)]
    backend = FakeTranscriptionBackend(result=replace(make_result(), words=words))
    env = make_env(backend)
    await env.service.run_sync(upload(), replace(PARAMS, word_timestamps=False))
    assert backend.last_options is not None and backend.last_options.word_timestamps is False


async def test_run_sync_error_propagates(make_env):
    env = make_env(FakeTranscriptionBackend(transcribe_error=RuntimeError("out of memory")))
    with pytest.raises(GatewayError) as info:
        await env.service.run_sync(upload(), PARAMS)
    assert (info.value.status_code, info.value.code) == (503, "model_unavailable")
    assert info.value.headers == {"Retry-After": "30"}
    record = next(iter(env.store.records.values()))
    assert record.status == "failed"


async def test_progress_from_memory(make_env, worker_for):
    gate = threading.Event()
    env = make_env(FakeTranscriptionBackend(transcribe_gate=gate, progress_steps=[0.5]))
    worker_for(env)
    record = await env.service.submit(upload(), PARAMS, title=None)
    assert env.service.progress(record) == 0.0
    await asyncio.to_thread(env.backend.transcribe_started.wait, 2)
    running = env.store.records[record.id]
    async with asyncio.timeout(2):
        while env.service.progress(running) != 0.5:
            await asyncio.sleep(0.01)
    gate.set()
    await env.wait_status(record.id, "done")


async def test_delete_running(make_env, worker_for):
    gate = threading.Event()
    env = make_env(FakeTranscriptionBackend(transcribe_gate=gate))
    worker_for(env)
    record = await env.service.submit(upload(), PARAMS, title=None)
    await asyncio.to_thread(env.backend.transcribe_started.wait, 2)
    await env.service.delete(record.id)
    assert record.id not in env.store.records
    assert list((env.files.root / "uploads").iterdir()) == []
    assert list((env.files.root / "audio").iterdir()) == []


async def test_delete_done_removes_audio(make_env, worker_for):
    env = make_env()
    worker_for(env)
    record = await env.service.submit(upload(), PARAMS, title=None)
    await env.wait_status(record.id, "done")
    await env.service.delete(record.id)
    assert list((env.files.root / "audio").iterdir()) == []
    with pytest.raises(GatewayError):
        await env.service.delete(record.id)


async def test_submit_too_large_leaves_nothing(make_env):
    env = make_env()
    with pytest.raises(GatewayError) as info:
        await env.service.submit(upload(data=b"x" * (1024 * 1024 + 1)), PARAMS, title=None)
    assert info.value.code == "file_too_large"
    assert env.store.records == {}


def test_prepare_params_validation(make_env):
    env = make_env()
    params = prepare_params(
        env.registry,
        env.manager,
        model="whisper-1",
        language="ru",
        prompt="",
        temperature=0.2,
        word_timestamps=True,
    )
    assert params == TranscriptionParams(
        model="whisper-large-v3-turbo",
        language="ru",
        prompt=None,
        temperature=0.2,
        word_timestamps=True,
    )
    with pytest.raises(GatewayError) as info:
        prepare_params(
            env.registry,
            env.manager,
            model="",
            language="xx",
            prompt=None,
            temperature=0.0,
            word_timestamps=False,
        )
    assert info.value.param == "language"
    with pytest.raises(GatewayError) as info:
        prepare_params(
            env.registry,
            env.manager,
            model="qwen3-14b",
            language=None,
            prompt=None,
            temperature=0.0,
            word_timestamps=False,
        )
    assert info.value.param == "model"
