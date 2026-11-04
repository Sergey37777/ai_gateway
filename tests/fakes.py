"""Тестовые двойники: управляемые часы и бэкенд распознавания без реальной модели."""

import json
import threading
import uuid
from collections.abc import AsyncIterator
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

from ai_gateway.backends.base import (
    JsonObject,
    Segment,
    TranscriptionCancelled,
    TranscriptionHooks,
    TranscriptionOptions,
    TranscriptionResult,
)
from ai_gateway.errors import database_unavailable
from ai_gateway.registry import WhisperSpec
from ai_gateway.store import (
    Cursor,
    ListItem,
    ListQuery,
    NewTranscription,
    Page,
    Status,
    TranscriptionRecord,
)


class FakeClock:
    """Монотонные часы, которые двигаются только вручную."""

    def __init__(self, now: float = 0.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def make_result(text: str = "привет мир") -> TranscriptionResult:
    segment = Segment(
        id=0,
        start=0.0,
        end=1.0,
        text=f" {text}",
        avg_logprob=-0.1,
        compression_ratio=1.0,
        no_speech_prob=0.0,
        temperature=0.0,
    )
    return TranscriptionResult(text=text, language="ru", duration=1.0, segments=[segment])


def spec(name: str = "m", ttl: int = 600, max_concurrency: int = 1) -> WhisperSpec:
    return WhisperSpec(
        name=name, backend="whisper", model="tiny", ttl=ttl, max_concurrency=max_concurrency
    )


class FakeTranscriptionBackend:
    """Бэкенд с счётчиками вызовов и внедряемыми ошибками."""

    def __init__(
        self,
        result: TranscriptionResult | None = None,
        *,
        load_error: Exception | None = None,
        transcribe_error: Exception | None = None,
        load_gate: threading.Event | None = None,
        transcribe_gate: threading.Event | None = None,
        progress_steps: list[float] | None = None,
    ) -> None:
        self.result = result if result is not None else make_result()
        self.load_error = load_error
        self.transcribe_error = transcribe_error
        self.load_gate = load_gate
        # transcribe ждёт gate (проверяя should_stop каждые 10 мс), до этого сообщив progress_steps
        self.transcribe_gate = transcribe_gate
        self.progress_steps = progress_steps or []
        self.transcribe_calls = 0
        self.transcribe_started = threading.Event()
        self.load_calls = 0
        self.unload_calls = 0
        self.last_options: TranscriptionOptions | None = None
        self.last_audio_path: Path | None = None
        self._loaded = False
        self.load_done = threading.Event()

    @property
    def loaded(self) -> bool:
        return self._loaded

    def load(self) -> None:
        self.load_calls += 1
        if self.load_gate is not None and not self.load_gate.wait(timeout=5):
            raise TimeoutError("load_gate не открыт")
        if self.load_error is not None:
            raise self.load_error
        self._loaded = True
        self.load_done.set()

    def unload(self) -> None:
        self.unload_calls += 1
        self._loaded = False

    def transcribe(
        self,
        audio_path: Path,
        options: TranscriptionOptions,
        hooks: TranscriptionHooks | None = None,
    ) -> TranscriptionResult:
        self.transcribe_calls += 1
        self.last_audio_path = audio_path
        self.last_options = options
        self.transcribe_started.set()
        if hooks is not None:
            for step in self.progress_steps:
                hooks.on_progress(step)
        if self.transcribe_gate is not None:
            while not self.transcribe_gate.wait(timeout=0.01):
                if hooks is not None and hooks.should_stop():
                    raise TranscriptionCancelled
        if hooks is not None and hooks.should_stop():
            raise TranscriptionCancelled
        if self.transcribe_error is not None:
            raise self.transcribe_error
        return self.result


class FakeLoadableBackend:
    """Бэкенд без transcribe (например, будущая чат-модель)."""

    def __init__(self) -> None:
        self.load_calls = 0
        self._loaded = False

    @property
    def loaded(self) -> bool:
        return self._loaded

    def load(self) -> None:
        self.load_calls += 1
        self._loaded = True

    def unload(self) -> None:
        self._loaded = False


FIXTURES_DIR = Path(__file__).parent / "fixtures" / "ollama"


class TrackingStream(httpx.AsyncByteStream):
    """SSE-поток кусками по 64 байта с признаком закрытия и обрывом после N кусков."""

    def __init__(self, data: bytes, *, fail_after: int | None = None) -> None:
        self.data = data
        self.fail_after = fail_after
        self.closed = False

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for number, start in enumerate(range(0, len(self.data), 64)):
            if self.fail_after is not None and number >= self.fail_after:
                raise httpx.RemoteProtocolError("поток оборван")
            yield self.data[start : start + 64]

    async def aclose(self) -> None:
        self.closed = True


def load_ollama_fixture(name: str) -> httpx.Response:
    """Ответ Ollama из `tests/fixtures/ollama/<name>.json|.sse`."""
    json_path = FIXTURES_DIR / f"{name}.json"
    if json_path.exists():
        recorded = json.loads(json_path.read_text(encoding="utf-8"))
        status = recorded["status"]
        body = recorded["body"]
        if isinstance(body, str):
            return httpx.Response(status, text=body)
        return httpx.Response(status, json=body)
    data = (FIXTURES_DIR / f"{name}.sse").read_bytes()
    return httpx.Response(
        200, headers={"content-type": "text/event-stream"}, stream=TrackingStream(data)
    )


def parse_sse(data: bytes) -> list[JsonObject]:
    """Разбор SSE-фикстуры в JSON-чанки (без `[DONE]`)."""
    chunks: list[JsonObject] = []
    for line in data.decode("utf-8").splitlines():
        if line.startswith("data:"):
            payload = line.removeprefix("data:").strip()
            if payload and payload != "[DONE]":
                chunks.append(json.loads(payload))
    return chunks


class FakeOllama:
    """Фейк Ollama поверх `httpx.MockTransport` с очередью ответов."""

    def __init__(self, *, up: bool = True) -> None:
        self.up = up
        self.requests: list[JsonObject] = []
        self._queue: list[httpx.Response | Exception] = []
        self.transport = httpx.MockTransport(self._handle)

    def queue(self, item: httpx.Response | Exception) -> None:
        self._queue.append(item)

    def queue_fixture(self, name: str) -> None:
        self.queue(load_ollama_fixture(name))

    def _handle(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/version":
            if not self.up:
                raise httpx.ConnectError("Ollama недоступна", request=request)
            return httpx.Response(200, json={"version": "test"})
        if request.url.path == "/v1/chat/completions":
            self.requests.append(json.loads(request.content))
            if not self._queue:
                raise httpx.ConnectError("очередь ответов пуста", request=request)
            item = self._queue.pop(0)
            if isinstance(item, Exception):
                raise item
            return item
        return httpx.Response(404)


class InMemoryTranscriptionStore:
    """`TranscriptionStore` в памяти: та же семантика переходов; поиск — подстрока."""

    def __init__(self) -> None:
        self.records: dict[uuid.UUID, TranscriptionRecord] = {}
        self.results: dict[uuid.UUID, TranscriptionResult] = {}
        self.available = True
        self._tick = 0

    def _now(self) -> datetime:
        # строго возрастающее время: порядок записей детерминирован
        self._tick += 1
        return datetime(2026, 11, 4, tzinfo=UTC) + timedelta(microseconds=self._tick)

    def _check(self) -> None:
        if not self.available:
            raise database_unavailable()

    def _put(self, tid: uuid.UUID, **changes: Any) -> TranscriptionRecord:
        record = replace(self.records[tid], **changes)
        self.records[tid] = record
        return record

    async def create(self, new: NewTranscription) -> TranscriptionRecord:
        self._check()
        now = self._now()
        record = TranscriptionRecord(
            id=new.id,
            status=new.status,
            source=new.source,
            title=new.title,
            filename=new.filename,
            params=new.params,
            upload_path=new.upload_path,
            audio_path=None,
            audio_bytes=None,
            language=None,
            duration=None,
            text=None,
            error_code=None,
            error_message=None,
            created_at=now,
            started_at=now if new.status == "running" else None,
            finished_at=None,
        )
        self.records[new.id] = record
        return record

    async def get(self, tid: uuid.UUID) -> TranscriptionRecord | None:
        self._check()
        return self.records.get(tid)

    async def get_result(self, tid: uuid.UUID) -> TranscriptionResult | None:
        self._check()
        return self.results.get(tid) if tid in self.records else None

    async def list(self, query: ListQuery) -> Page:
        self._check()
        records = sorted(self.records.values(), key=lambda r: (r.created_at, r.id), reverse=True)
        if query.q:
            needle = query.q.lower()
            records = [
                r for r in records if needle in r.title.lower() or needle in (r.text or "").lower()
            ]
        if query.status is not None:
            records = [r for r in records if r.status == query.status]
        if query.before is not None:
            bound = (query.before.created_at, query.before.id)
            records = [r for r in records if (r.created_at, r.id) < bound]
        limit = max(1, min(query.limit, 100))
        page = records[:limit]
        has_more = len(records) > limit
        last = page[-1] if page else None
        return Page(
            items=[ListItem(record=r) for r in page],
            next=Cursor(created_at=last.created_at, id=last.id) if has_more and last else None,
        )

    async def claim_next(self) -> TranscriptionRecord | None:
        self._check()
        queued = sorted(
            (r for r in self.records.values() if r.status == "queued"),
            key=lambda r: (r.created_at, r.id),
        )
        if not queued:
            return None
        return self._put(queued[0].id, status="running", started_at=self._now())

    async def finish(
        self,
        tid: uuid.UUID,
        result: TranscriptionResult,
        audio_path: str | None,
        audio_bytes: int | None,
    ) -> None:
        self._check()
        record = self.records.get(tid)
        if record is None or record.status != "running":
            return
        self._put(
            tid,
            status="done",
            upload_path=None,
            audio_path=audio_path,
            audio_bytes=audio_bytes,
            language=result.language,
            duration=result.duration,
            text=result.text,
            finished_at=self._now(),
        )
        self.results[tid] = result

    async def _final(
        self, tid: uuid.UUID, status: Status, code: str | None, message: str | None
    ) -> None:
        self._check()
        record = self.records.get(tid)
        if record is None or record.status not in ("queued", "running"):
            return
        self._put(
            tid, status=status, error_code=code, error_message=message, finished_at=self._now()
        )

    async def fail(self, tid: uuid.UUID, code: str, message: str) -> None:
        await self._final(tid, "failed", code, message)

    async def cancel(self, tid: uuid.UUID) -> None:
        await self._final(tid, "cancelled", None, None)

    async def requeue(self, tid: uuid.UUID) -> TranscriptionRecord | None:
        self._check()
        record = self.records.get(tid)
        if (
            record is None
            or record.status not in ("failed", "cancelled")
            or record.upload_path is None
        ):
            return None
        return self._put(
            tid,
            status="queued",
            error_code=None,
            error_message=None,
            started_at=None,
            finished_at=None,
        )

    async def requeue_running(self) -> int:
        self._check()
        running = [r.id for r in self.records.values() if r.status == "running"]
        for tid in running:
            self._put(tid, status="queued", started_at=None)
        return len(running)

    async def rename(self, tid: uuid.UUID, title: str) -> TranscriptionRecord | None:
        self._check()
        return self._put(tid, title=title) if tid in self.records else None

    async def delete(self, tid: uuid.UUID) -> TranscriptionRecord | None:
        self._check()
        self.results.pop(tid, None)
        return self.records.pop(tid, None)

    async def queue_position(self, tid: uuid.UUID) -> int | None:
        self._check()
        record = self.records.get(tid)
        if record is None or record.status != "queued":
            return None
        ahead = [
            r
            for r in self.records.values()
            if r.status == "queued" and (r.created_at, r.id) < (record.created_at, record.id)
        ]
        return 1 + len(ahead)

    async def counts(self) -> dict[Status, int]:
        self._check()
        counts: dict[Status, int] = {}
        for record in self.records.values():
            counts[record.status] = counts.get(record.status, 0) + 1
        return counts

    async def file_paths(self) -> set[str]:
        self._check()
        return {
            path
            for r in self.records.values()
            for path in (r.upload_path, r.audio_path)
            if path is not None
        }

    async def ping(self) -> bool:
        return self.available
