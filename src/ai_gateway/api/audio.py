"""POST /v1/audio/transcriptions — распознавание речи, совместимое с OpenAI."""

from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, UploadFile
from starlette.responses import Response

from ai_gateway.api.deps import get_manager, get_registry, get_service
from ai_gateway.errors import GatewayError
from ai_gateway.formatting import is_response_format, render
from ai_gateway.jobs import TranscriptionService, prepare_params
from ai_gateway.lifecycle import ModelManager
from ai_gateway.registry import ModelRegistry

router = APIRouter()

GRANULARITIES = frozenset({"segment", "word"})


def _bad_param(param: str, message: str) -> GatewayError:
    return GatewayError(400, "invalid_request_error", message, param=param)


@router.post("/audio/transcriptions")
async def create_transcription(
    file: Annotated[UploadFile, File()],
    registry: Annotated[ModelRegistry, Depends(get_registry)],
    manager: Annotated[ModelManager, Depends(get_manager)],
    service: Annotated[TranscriptionService, Depends(get_service)],
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
    include_words = "word" in timestamp_granularities
    # до чтения файла: не-речевая модель не должна попадать в VRAM
    params = prepare_params(
        registry,
        manager,
        model=model,
        language=language,
        prompt=prompt,
        temperature=temperature,
        word_timestamps=include_words,
    )
    # через исполнитель истории: запись source=api, обрыв соединения не теряет работу
    result = await service.run_sync(file, params)
    return render(result, response_format, include_words=include_words)
