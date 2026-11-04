import copy
import sys
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from typing import Any, Protocol

import httpx
import pytest
from loguru import logger

from ai_gateway.app import create_app
from ai_gateway.backends.ollama import OllamaChatBackend
from ai_gateway.config import Settings
from ai_gateway.lifecycle import ModelManager
from ai_gateway.registry import ModelRegistry
from tests.fakes import FakeOllama, FakeTranscriptionBackend

# реестр как в models.yaml (спецификация §4.4)
REGISTRY_DATA: dict[str, Any] = {
    "default_transcription": "whisper-large-v3-turbo",
    "aliases": {"whisper-1": "whisper-large-v3-turbo", "gpt-4o-mini": "qwen3-14b"},
    "models": {
        "qwen3-14b": {"backend": "ollama", "model": "qwen3:14b"},
        "whisper-large-v3": {
            "backend": "whisper",
            "model": "large-v3",
            "ttl": 600,
            "max_concurrency": 1,
            "vad_filter": True,
        },
        "whisper-large-v3-turbo": {"backend": "whisper", "model": "large-v3-turbo", "ttl": 600},
    },
}


@pytest.fixture(autouse=True)
def restore_logging() -> Iterator[None]:
    # configure_logging (тесты lifespan/логов) меняет глобальный loguru: вернуть как было
    yield
    logger.remove()
    logger.configure(extra={"request_id": "-"})
    logger.add(sys.stderr)


class GatewayClient(httpx.AsyncClient):
    """HTTP-клиент к приложению с доступом к фейковому бэкенду."""

    backend: FakeTranscriptionBackend
    ollama: FakeOllama


class MakeClient(Protocol):
    def __call__(
        self,
        *,
        api_key: str | None = None,
        max_upload_mb: int = 200,
        backend: FakeTranscriptionBackend | None = None,
        ollama: FakeOllama | None = None,
    ) -> Awaitable[GatewayClient]: ...


@pytest.fixture
async def make_client() -> AsyncIterator[MakeClient]:
    clients: list[GatewayClient] = []
    chat_backends: list[OllamaChatBackend] = []

    async def _make(
        *,
        api_key: str | None = None,
        max_upload_mb: int = 200,
        backend: FakeTranscriptionBackend | None = None,
        ollama: FakeOllama | None = None,
    ) -> GatewayClient:
        fake_ollama = ollama if ollama is not None else FakeOllama()
        chat_backend = OllamaChatBackend(
            "http://ollama", read_timeout=5, transport=fake_ollama.transport
        )
        chat_backends.append(chat_backend)
        fake = backend if backend is not None else FakeTranscriptionBackend()
        settings = Settings(
            _env_file=None, device="cpu", api_key=api_key, max_upload_mb=max_upload_mb
        )
        registry = ModelRegistry.from_dict(copy.deepcopy(REGISTRY_DATA), default_ttl=600)
        factory: Callable[..., FakeTranscriptionBackend] = lambda _spec: fake  # noqa: E731
        manager = ModelManager(registry.whisper_specs(), factory)
        app = create_app(settings, registry=registry, manager=manager, chat_backend=chat_backend)
        client = GatewayClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        client.backend = fake
        client.ollama = fake_ollama
        clients.append(client)
        return client

    yield _make
    for client in clients:
        await client.aclose()
    for chat_backend in chat_backends:
        await chat_backend.aclose()
