"""Протоколы бэкендов и типы результата распознавания."""

from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, runtime_checkable

from ai_gateway.registry import OllamaSpec

# JSON-объект: значения разбираются через isinstance, без Any
JsonObject = dict[str, object]


@dataclass(frozen=True, slots=True)
class Word:
    """Слово с временными метками (секунды)."""

    word: str
    start: float
    end: float


@dataclass(frozen=True, slots=True)
class Segment:
    """Сегмент распознанной речи в терминах OpenAI verbose_json."""

    id: int
    start: float
    end: float
    text: str
    avg_logprob: float
    compression_ratio: float
    no_speech_prob: float
    temperature: float
    # поля OpenAI TranscriptionSegment: смещение окна декодера и токены сегмента
    seek: int = 0
    tokens: list[int] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class TranscriptionOptions:
    """Параметры запроса; `vad_filter` берётся бэкендом из конфигурации модели."""

    language: str | None = None
    prompt: str | None = None
    temperature: float = 0.0
    word_timestamps: bool = False


@dataclass(frozen=True, slots=True)
class TranscriptionResult:
    """Результат распознавания; `text` уже собран бэкендом."""

    text: str
    language: str
    duration: float
    segments: list[Segment]
    words: list[Word] | None = None


@dataclass(frozen=True, slots=True)
class TranscriptionHooks:
    """Связь с исполнителем: ход (доля 0..1) и запрос остановки; вызываются из потока инференса."""

    on_progress: Callable[[float], None]
    should_stop: Callable[[], bool]


class TranscriptionCancelled(Exception):
    """Распознавание остановлено по `should_stop` между сегментами."""


class LoadableBackend(Protocol):
    """Бэкенд, веса которого шлюз загружает и выгружает сам."""

    def load(self) -> None:
        """Блокирующая загрузка весов на устройство."""
        ...

    def unload(self) -> None:
        """Освобождение памяти."""
        ...

    @property
    def loaded(self) -> bool:
        """Загружены ли веса."""
        ...


@runtime_checkable
class TranscriptionBackend(LoadableBackend, Protocol):
    """Бэкенд распознавания речи."""

    def transcribe(
        self,
        audio_path: Path,
        options: TranscriptionOptions,
        hooks: TranscriptionHooks | None = None,
    ) -> TranscriptionResult:
        """Блокирующее распознавание файла; `hooks` — ход и остановка между сегментами."""
        ...


class ChatBackend(Protocol):
    """Бэкенд чата: HTTP-клиент к Ollama, веса которой ведёт она сама."""

    async def complete(self, spec: OllamaSpec, payload: JsonObject) -> JsonObject:
        """Нестриминговый запрос; тело ответа Ollama как есть."""
        ...

    def stream(
        self, spec: OllamaSpec, payload: JsonObject
    ) -> AbstractAsyncContextManager[AsyncIterator[JsonObject]]:
        """Стрим: ошибки статуса бросаются при входе, соединение закрывается при выходе."""
        ...

    async def ping(self) -> bool:
        """Доступна ли Ollama."""
        ...

    async def aclose(self) -> None:
        """Закрытие HTTP-клиента."""
        ...
