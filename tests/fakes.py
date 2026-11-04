"""Тестовые двойники: управляемые часы и бэкенд распознавания без реальной модели."""

import json
import threading
from collections.abc import AsyncIterator
from pathlib import Path

import httpx

from ai_gateway.backends.base import JsonObject, Segment, TranscriptionOptions, TranscriptionResult
from ai_gateway.registry import WhisperSpec


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
    ) -> None:
        self.result = result if result is not None else make_result()
        self.load_error = load_error
        self.transcribe_error = transcribe_error
        self.load_gate = load_gate
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

    def transcribe(self, audio_path: Path, options: TranscriptionOptions) -> TranscriptionResult:
        self.last_audio_path = audio_path
        self.last_options = options
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
