"""Протоколы бэкендов и типы результата распознавания."""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, runtime_checkable

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

    def transcribe(self, audio_path: Path, options: TranscriptionOptions) -> TranscriptionResult:
        """Блокирующее распознавание файла."""
        ...
