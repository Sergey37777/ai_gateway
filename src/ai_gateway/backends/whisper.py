"""WhisperBackend — типизированная обёртка над faster-whisper.

Типы `faster_whisper` и `av` (без стабов) наружу не протекают: модуль отдаёт только
dataclass'ы из `backends.base`.
"""

import gc
from pathlib import Path
from typing import Any

import av
from faster_whisper import WhisperModel

from ai_gateway.backends.base import (
    Segment,
    TranscriptionOptions,
    TranscriptionResult,
    Word,
)
from ai_gateway.errors import GatewayError


class WhisperBackend:
    """Модель faster-whisper; веса грузятся в `load()`, не в конструкторе."""

    def __init__(
        self,
        model: str,
        *,
        device: str,
        compute_type: str,
        vad_filter: bool = True,
        download_root: str | None = None,
    ) -> None:
        self._model_name = model
        self._device = device
        self._compute_type = compute_type
        self._vad_filter = vad_filter
        self._download_root = download_root
        # Any: faster_whisper без стабов; объект не покидает этот модуль
        self._model: Any = None

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def load(self) -> None:
        self._model = WhisperModel(
            self._model_name,
            device=self._device,
            compute_type=self._compute_type,
            download_root=self._download_root,
        )

    def unload(self) -> None:
        self._model = None
        gc.collect()

    def transcribe(self, audio_path: Path, options: TranscriptionOptions) -> TranscriptionResult:
        if self._model is None:
            raise RuntimeError("Модель не загружена")
        try:
            raw_segments, info = self._model.transcribe(
                str(audio_path),
                language=options.language or None,
                initial_prompt=options.prompt or None,
                temperature=options.temperature,
                word_timestamps=options.word_timestamps,
                vad_filter=self._vad_filter,
            )
            # генератор ленивый: декодирование и инференс идут при итерации
            raw = list(raw_segments)
        except (av.error.FFmpegError, IndexError) as exc:
            # IndexError — у файла нет аудиопотока
            raise GatewayError(
                400, "invalid_audio", "Не удалось декодировать аудиофайл", param="file"
            ) from exc

        segments = [
            Segment(
                id=int(s.id),
                start=float(s.start),
                end=float(s.end),
                text=str(s.text),
                avg_logprob=float(s.avg_logprob),
                compression_ratio=float(s.compression_ratio),
                no_speech_prob=float(s.no_speech_prob),
                temperature=float(s.temperature or 0.0),
            )
            for s in raw
        ]
        words: list[Word] | None = None
        if options.word_timestamps:
            words = [
                Word(word=str(w.word), start=float(w.start), end=float(w.end))
                for s in raw
                for w in (s.words or [])
            ]
        return TranscriptionResult(
            text=" ".join(s.text.strip() for s in segments).strip(),
            language=str(info.language),
            duration=float(info.duration),
            segments=segments,
            words=words,
        )
