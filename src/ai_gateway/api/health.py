"""GET /health — состояние сервиса и моделей; без авторизации."""

from dataclasses import asdict
from typing import Annotated

from fastapi import APIRouter, Depends, Request

from ai_gateway.api.deps import get_manager
from ai_gateway.lifecycle import ModelManager

router = APIRouter()


@router.get("/health")
async def health(
    request: Request,
    manager: Annotated[ModelManager, Depends(get_manager)],
) -> dict[str, object]:
    device: str = request.app.state.device
    return {
        "status": "ok",
        "device": device,
        "models": [asdict(s) for s in manager.status()],
    }
