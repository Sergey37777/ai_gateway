"""GET /health — состояние сервиса и моделей; без авторизации."""

from dataclasses import asdict
from typing import Annotated

from fastapi import APIRouter, Depends, Request

from ai_gateway.api.deps import get_chat_backend, get_manager
from ai_gateway.backends.base import ChatBackend
from ai_gateway.lifecycle import ModelManager

router = APIRouter()


@router.get("/health")
async def health(
    request: Request,
    manager: Annotated[ModelManager, Depends(get_manager)],
    backend: Annotated[ChatBackend, Depends(get_chat_backend)],
) -> dict[str, object]:
    device: str = request.app.state.device
    return {
        "status": "ok",
        "device": device,
        "ollama": "ok" if await backend.ping() else "unavailable",
        "models": [asdict(s) for s in manager.status()],
    }
