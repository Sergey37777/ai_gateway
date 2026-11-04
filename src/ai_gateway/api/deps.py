"""Зависимости FastAPI: объекты из `app.state` и проверка API-ключа."""

import secrets

from fastapi import Request

from ai_gateway.config import Settings
from ai_gateway.errors import GatewayError
from ai_gateway.lifecycle import ModelManager
from ai_gateway.registry import ModelRegistry


def get_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def get_registry(request: Request) -> ModelRegistry:
    registry: ModelRegistry = request.app.state.registry
    return registry


def get_manager(request: Request) -> ModelManager:
    manager: ModelManager = request.app.state.manager
    return manager


async def require_api_key(request: Request) -> None:
    """Если `AIGW_API_KEY` задан — требует `Authorization: Bearer <key>`."""
    expected = get_settings(request).api_key
    if not expected:
        return
    header = request.headers.get("Authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not secrets.compare_digest(
        token.strip().encode(), expected.encode()
    ):
        raise GatewayError(401, "invalid_api_key", "Неверный или отсутствующий API-ключ")
