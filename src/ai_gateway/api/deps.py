"""Зависимости FastAPI: объекты из `app.state` и проверка API-ключа."""

import secrets

from fastapi import Request

from ai_gateway.backends.base import ChatBackend
from ai_gateway.config import Settings
from ai_gateway.conversations import ConversationStore
from ai_gateway.errors import GatewayError
from ai_gateway.jobs import TranscriptionService
from ai_gateway.lifecycle import ModelManager
from ai_gateway.registry import ModelRegistry
from ai_gateway.store import TranscriptionStore


def get_settings(request: Request) -> Settings:
    settings: Settings = request.app.state.settings
    return settings


def get_registry(request: Request) -> ModelRegistry:
    registry: ModelRegistry = request.app.state.registry
    return registry


def get_manager(request: Request) -> ModelManager:
    manager: ModelManager = request.app.state.manager
    return manager


def get_chat_backend(request: Request) -> ChatBackend:
    backend: ChatBackend = request.app.state.chat_backend
    return backend


def get_store(request: Request) -> TranscriptionStore:
    store: TranscriptionStore = request.app.state.store
    return store


def get_conversations(request: Request) -> ConversationStore:
    conversations: ConversationStore = request.app.state.conversations
    return conversations


def get_service(request: Request) -> TranscriptionService:
    service: TranscriptionService = request.app.state.service
    return service


def api_key_valid(authorization: str, expected: str) -> bool:
    """Совпадает ли `Authorization: Bearer <key>` с ожидаемым ключом (за постоянное время)."""
    scheme, _, token = authorization.partition(" ")
    return scheme.lower() == "bearer" and secrets.compare_digest(
        token.strip().encode(), expected.encode()
    )


def invalid_api_key() -> GatewayError:
    return GatewayError(401, "invalid_api_key", "Неверный или отсутствующий API-ключ")
