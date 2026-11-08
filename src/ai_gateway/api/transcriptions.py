"""`/api/transcriptions…` — фоновые распознавания и история (собственный API шлюза, не OpenAI)."""

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from pydantic import BaseModel
from starlette.responses import FileResponse, Response

from ai_gateway.api.deps import get_manager, get_registry, get_service, get_store
from ai_gateway.errors import GatewayError, transcription_not_found
from ai_gateway.formatting import is_response_format, render
from ai_gateway.jobs import TranscriptionService, prepare_params
from ai_gateway.lifecycle import ModelManager
from ai_gateway.registry import ModelRegistry
from ai_gateway.store import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    ListQuery,
    TranscriptionRecord,
    TranscriptionStore,
    decode_cursor,
    encode_cursor,
    is_status,
)

router = APIRouter()

MAX_TITLE = 200


def iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def transcription_json(
    record: TranscriptionRecord,
    *,
    progress: float | None,
    queue_position: int | None,
    snippet: str | None = None,
) -> dict[str, object]:
    """Объект распознавания (спецификация этапа 4, §7.1)."""
    body: dict[str, object] = {
        "id": str(record.id),
        "status": record.status,
        "source": record.source,
        "title": record.title,
        "filename": record.filename,
        "model": record.params.model,
        "language": record.language,
        "duration": record.duration,
        "progress": progress,
        "queue_position": queue_position,
        "error": (
            {"code": record.error_code, "message": record.error_message or ""}
            if record.status == "failed" and record.error_code is not None
            else None
        ),
        "has_audio": record.audio_path is not None,
        # «Повторить» возможно, только пока хранится загрузка
        "retryable": record.status in ("failed", "cancelled") and record.upload_path is not None,
        "created_at": iso(record.created_at),
        "started_at": iso(record.started_at),
        "finished_at": iso(record.finished_at),
    }
    if snippet is not None:
        body["snippet"] = snippet
    return body


def _parse_id(value: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError as exc:
        raise transcription_not_found(value) from exc


async def _record(store: TranscriptionStore, tid: str) -> TranscriptionRecord:
    record = await store.get(_parse_id(tid))
    if record is None:
        raise transcription_not_found(tid)
    return record


async def _json(
    service: TranscriptionService, store: TranscriptionStore, record: TranscriptionRecord
) -> dict[str, object]:
    position = await store.queue_position(record.id) if record.status == "queued" else None
    return transcription_json(record, progress=service.progress(record), queue_position=position)


Store = Annotated[TranscriptionStore, Depends(get_store)]
Service = Annotated[TranscriptionService, Depends(get_service)]


@router.post("/transcriptions", status_code=202)
async def create(
    file: Annotated[UploadFile, File()],
    registry: Annotated[ModelRegistry, Depends(get_registry)],
    manager: Annotated[ModelManager, Depends(get_manager)],
    service: Service,
    store: Store,
    model: Annotated[str, Form()] = "",
    language: Annotated[str | None, Form()] = None,
    prompt: Annotated[str | None, Form()] = None,
    temperature: Annotated[float, Form()] = 0.0,
    title: Annotated[str | None, Form()] = None,
) -> dict[str, object]:
    # слова нужны UI всегда: подсветка, перемотка, а дальше — разметка спикеров
    params = prepare_params(
        registry,
        manager,
        model=model,
        language=language,
        prompt=prompt,
        temperature=temperature,
        word_timestamps=True,
    )
    clean_title = (title or "").strip()[:MAX_TITLE] or None
    record = await service.submit(file, params, title=clean_title)
    return await _json(service, store, record)


@router.get("/transcriptions")
async def list_transcriptions(
    service: Service,
    store: Store,
    q: str | None = None,
    status: str | None = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    before: str | None = None,
) -> dict[str, object]:
    if status is not None and not is_status(status):
        raise GatewayError(
            400, "invalid_request_error", f"Неизвестный статус '{status}'", param="status"
        )
    query = ListQuery(
        q=(q or "").strip() or None,
        status=status if status is not None and is_status(status) else None,
        limit=limit,
        before=decode_cursor(before) if before else None,
    )
    page = await store.list(query)
    data = []
    for item in page.items:
        record = item.record
        position = await store.queue_position(record.id) if record.status == "queued" else None
        data.append(
            transcription_json(
                record,
                progress=service.progress(record),
                queue_position=position,
                snippet=item.snippet,
            )
        )
    return {"data": data, "next": encode_cursor(page.next) if page.next else None}


@router.get("/transcriptions/{tid}")
async def get_transcription(tid: str, service: Service, store: Store) -> dict[str, object]:
    return await _json(service, store, await _record(store, tid))


@router.get("/transcriptions/{tid}/result")
async def get_result(tid: str, store: Store, format: str = "verbose_json") -> Response:
    if not is_response_format(format):
        raise GatewayError(
            400, "invalid_request_error", f"Неподдерживаемый формат '{format}'", param="format"
        )
    record = await _record(store, tid)
    result = await store.get_result(record.id) if record.status == "done" else None
    if result is None:
        raise GatewayError(409, "transcription_not_ready", "Распознавание ещё не готово")
    return render(result, format, include_words=result.words is not None)


@router.get("/transcriptions/{tid}/audio")
async def get_audio(tid: str, service: Service, store: Store) -> Response:
    record = await _record(store, tid)
    path = None if record.audio_path is None else service.files.resolve(record.audio_path)
    if path is None or not path.exists():
        raise GatewayError(404, "audio_not_found", "Аудио для этой записи нет")
    # FileResponse отвечает на Range (206) — перемотка во внешних плеерах
    return FileResponse(path, media_type="audio/webm")


class TitlePatch(BaseModel):
    title: str


@router.patch("/transcriptions/{tid}")
async def rename(tid: str, patch: TitlePatch, service: Service, store: Store) -> dict[str, object]:
    title = patch.title.strip()
    if not title or len(title) > MAX_TITLE:
        raise GatewayError(
            400,
            "invalid_request_error",
            f"Название — от 1 до {MAX_TITLE} символов",
            param="title",
        )
    record = await store.rename(_parse_id(tid), title)
    if record is None:
        raise transcription_not_found(tid)
    return await _json(service, store, record)


@router.post("/transcriptions/{tid}/cancel")
async def cancel(tid: str, service: Service, store: Store) -> dict[str, object]:
    return await _json(service, store, await service.cancel(_parse_id(tid)))


@router.post("/transcriptions/{tid}/retry")
async def retry(tid: str, service: Service, store: Store) -> dict[str, object]:
    return await _json(service, store, await service.retry(_parse_id(tid)))


@router.delete("/transcriptions/{tid}", status_code=204)
async def delete(tid: str, service: Service) -> Response:
    await service.delete(_parse_id(tid))
    return Response(status_code=204)
