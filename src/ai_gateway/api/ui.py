"""GET /ui/config — настройки для Web UI; без авторизации, как /health."""

from typing import Annotated

from fastapi import APIRouter, Depends

from ai_gateway.api.deps import get_registry, get_settings
from ai_gateway.config import Settings
from ai_gateway.languages import LANGUAGES
from ai_gateway.registry import ModelRegistry, spec_kind

router = APIRouter()


@router.get("/ui/config")
async def ui_config(
    settings: Annotated[Settings, Depends(get_settings)],
    registry: Annotated[ModelRegistry, Depends(get_registry)],
) -> dict[str, object]:
    return {
        "max_upload_mb": settings.max_upload_mb,
        # сам ключ не отдаётся: UI лишь узнаёт, что его надо спросить
        "auth_required": bool(settings.api_key),
        "default_transcription": registry.default_transcription,
        # только реальные модели: алиасы нужны клиентам с захардкоженными именами
        "models": [{"id": s.name, "kind": spec_kind(s)} for s in registry.specs()],
        "languages": [{"code": code, "name": name} for code, name in LANGUAGES.items()],
    }
