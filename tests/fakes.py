"""Тестовые двойники: управляемые часы и бэкенд распознавания без реальной модели."""

import threading
from pathlib import Path

from ai_gateway.backends.base import Segment, TranscriptionOptions, TranscriptionResult
from ai_gateway.registry import ModelSpec


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


def spec(name: str = "m", ttl: int = 600, max_concurrency: int = 1) -> ModelSpec:
    return ModelSpec(
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
