import copy
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, Protocol

import httpx
import pytest

from ai_gateway.app import create_app
from ai_gateway.config import Settings
from ai_gateway.lifecycle import ModelManager
from ai_gateway.registry import ModelRegistry
from tests.fakes import FakeTranscriptionBackend

# реестр как в models.yaml (спецификация §4.4)
REGISTRY_DATA: dict[str, Any] = {
    "default_transcription": "whisper-large-v3-turbo",
    "aliases": {"whisper-1": "whisper-large-v3-turbo"},
    "models": {
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


class GatewayClient(httpx.AsyncClient):
    """HTTP-клиент к приложению с доступом к фейковому бэкенду."""

    backend: FakeTranscriptionBackend


class MakeClient(Protocol):
    def __call__(
        self,
        *,
        api_key: str | None = None,
        max_upload_mb: int = 200,
        backend: FakeTranscriptionBackend | None = None,
    ) -> Awaitable[GatewayClient]: ...


@pytest.fixture
async def make_client() -> AsyncIterator[MakeClient]:
    clients: list[GatewayClient] = []

    async def _make(
        *,
        api_key: str | None = None,
        max_upload_mb: int = 200,
        backend: FakeTranscriptionBackend | None = None,
    ) -> GatewayClient:
        fake = backend if backend is not None else FakeTranscriptionBackend()
        settings = Settings(
            _env_file=None, device="cpu", api_key=api_key, max_upload_mb=max_upload_mb
        )
        registry = ModelRegistry.from_dict(copy.deepcopy(REGISTRY_DATA), default_ttl=600)
        factory: Callable[..., FakeTranscriptionBackend] = lambda _spec: fake  # noqa: E731
        manager = ModelManager(registry.specs(), factory)
        app = create_app(settings, registry=registry, manager=manager)
        client = GatewayClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        client.backend = fake
        clients.append(client)
        return client

    yield _make
    for client in clients:
        await client.aclose()
