"""POST /v1/audio/transcriptions — распознавание речи, совместимое с OpenAI."""

import asyncio
import tempfile
import time
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, UploadFile
from loguru import logger
from starlette.responses import Response

from ai_gateway.api.deps import get_manager, get_registry, get_settings
from ai_gateway.backends.base import TranscriptionBackend, TranscriptionOptions
from ai_gateway.config import Settings
from ai_gateway.errors import GatewayError, model_unavailable
from ai_gateway.formatting import is_response_format, render
from ai_gateway.languages import LANGUAGES
from ai_gateway.lifecycle import ModelManager
from ai_gateway.registry import ModelRegistry

router = APIRouter()

CHUNK_SIZE = 1024 * 1024
GRANULARITIES = frozenset({"segment", "word"})


def file_too_large(max_upload_mb: int) -> GatewayError:
    return GatewayError(
        413, "file_too_large", f"Файл больше лимита {max_upload_mb} МБ", param="file"
    )


def _bad_param(param: str, message: str) -> GatewayError:
    return GatewayError(400, "invalid_request_error", message, param=param)


async def _save_upload(upload: UploadFile, path: Path, limit: int, max_upload_mb: int) -> int:
    """Копирует загрузку во временный файл чанками; превышение лимита → 413."""
    size = 0
    with path.open("wb") as out:
        while chunk := await upload.read(CHUNK_SIZE):
            size += len(chunk)
            if size > limit:
                raise file_too_large(max_upload_mb)
            await asyncio.to_thread(out.write, chunk)
    return size


@router.post("/audio/transcriptions")
async def create_transcription(
    file: Annotated[UploadFile, File()],
    settings: Annotated[Settings, Depends(get_settings)],
    registry: Annotated[ModelRegistry, Depends(get_registry)],
    manager: Annotated[ModelManager, Depends(get_manager)],
    model: Annotated[str, Form()] = "",
    language: Annotated[str | None, Form()] = None,
    prompt: Annotated[str | None, Form()] = None,
    temperature: Annotated[float, Form()] = 0.0,
    response_format: Annotated[str, Form()] = "json",
    timestamp_granularities: Annotated[list[str], Form(alias="timestamp_granularities[]")] = [],  # noqa: B006 — FastAPI копирует значение по умолчанию на каждый запрос
) -> Response:
    if not is_response_format(response_format):
        raise _bad_param("response_format", f"Неподдерживаемый формат '{response_format}'")
    unknown = set(timestamp_granularities) - GRANULARITIES
    if unknown:
        raise _bad_param(
            "timestamp_granularities[]", f"Неизвестная гранулярность: {', '.join(sorted(unknown))}"
        )
    if language and language not in LANGUAGES:
        raise _bad_param("language", f"Неизвестный код языка '{language}'")
    spec = registry.resolve(model)

    include_words = "word" in timestamp_granularities
    options = TranscriptionOptions(
        language=language or None,
        prompt=prompt or None,
        temperature=temperature,
        word_timestamps=include_words,
    )
    limit = settings.max_upload_mb * 1024 * 1024
    with tempfile.NamedTemporaryFile(delete=False, suffix=Path(file.filename or "").suffix) as tmp:
        path = Path(tmp.name)
    try:
        if await _save_upload(file, path, limit, settings.max_upload_mb) == 0:
            raise GatewayError(400, "invalid_audio", "Пустой аудиофайл", param="file")
        async with manager.acquire(spec.name) as backend:
            if not isinstance(backend, TranscriptionBackend):
                raise _bad_param("model", f"Модель '{spec.name}' не распознаёт речь")
            started = time.perf_counter()
            try:
                result = await asyncio.to_thread(backend.transcribe, path, options)
            except RuntimeError as exc:
                if "out of memory" in str(exc).lower():
                    raise model_unavailable(f"Модели {spec.name} не хватило памяти: {exc}") from exc
                raise
        logger.info(
            "Распознано: модель={}, аудио={:.1f} с, обработка={:.1f} с",
            spec.name,
            result.duration,
            time.perf_counter() - started,
        )
        return render(result, response_format, include_words=include_words)
    finally:
        # синхронно: удаление должно пройти и при отмене запроса (обрыв соединения)
        path.unlink(missing_ok=True)  # noqa: ASYNC240
