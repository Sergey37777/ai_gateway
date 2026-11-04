"""GET /v1/models — модели и алиасы реестра в формате OpenAI."""

from typing import Annotated

from fastapi import APIRouter, Depends

from ai_gateway.api.deps import get_registry
from ai_gateway.registry import ModelRegistry

router = APIRouter()


@router.get("/models")
async def list_models(
    registry: Annotated[ModelRegistry, Depends(get_registry)],
) -> dict[str, object]:
    return {
        "object": "list",
        "data": [
            {"id": model_id, "object": "model", "created": 0, "owned_by": "ai_gateway"}
            for model_id in registry.model_ids()
        ],
    }
