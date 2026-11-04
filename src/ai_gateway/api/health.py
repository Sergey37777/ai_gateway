"""GET /health — состояние сервиса и моделей; без авторизации."""

from dataclasses import asdict
from typing import Annotated

from fastapi import APIRouter, Depends, Request

from ai_gateway.api.deps import get_chat_backend, get_manager, get_store
from ai_gateway.backends.base import ChatBackend
from ai_gateway.lifecycle import ModelManager
from ai_gateway.store import TranscriptionStore

router = APIRouter()


@router.get("/health")
async def health(
    request: Request,
    manager: Annotated[ModelManager, Depends(get_manager)],
    backend: Annotated[ChatBackend, Depends(get_chat_backend)],
    store: Annotated[TranscriptionStore, Depends(get_store)],
) -> dict[str, object]:
    device: str = request.app.state.device
    database = await store.ping()
    queue: dict[str, int] | None = None
    if database:
        counts = await store.counts()
        queue = {"queued": counts.get("queued", 0), "running": counts.get("running", 0)}
    return {
        "status": "ok",
        "device": device,
        "ollama": "ok" if await backend.ping() else "unavailable",
        "database": "ok" if database else "unavailable",
        "queue": queue,
        "models": [asdict(s) for s in manager.status()],
    }
