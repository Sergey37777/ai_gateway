import contextlib
import copy
import sys
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Protocol

import httpx
import pytest
from fastapi import FastAPI
from loguru import logger
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from ai_gateway.app import create_app
from ai_gateway.backends.ollama import OllamaChatBackend
from ai_gateway.config import Settings
from ai_gateway.db.engine import create_engine
from ai_gateway.lifecycle import ModelManager
from ai_gateway.registry import ModelRegistry
from tests.fakes import (
    FakeOllama,
    FakeTranscriptionBackend,
    InMemoryTranscriptionStore,
    fake_encode,
)

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
    store: InMemoryTranscriptionStore
    app: FastAPI


class MakeClient(Protocol):
    def __call__(
        self,
        *,
        api_key: str | None = None,
        max_upload_mb: int = 200,
        backend: FakeTranscriptionBackend | None = None,
        ollama: FakeOllama | None = None,
        web_dir: Path | None = None,
    ) -> Awaitable[GatewayClient]: ...


@pytest.fixture
async def make_client(tmp_path: Path) -> AsyncIterator[MakeClient]:
    clients: list[GatewayClient] = []
    chat_backends: list[OllamaChatBackend] = []
    # lifespan каждого приложения (воркер, хранилище) закрывается после теста
    lifespans = contextlib.AsyncExitStack()

    async def _make(
        *,
        api_key: str | None = None,
        max_upload_mb: int = 200,
        backend: FakeTranscriptionBackend | None = None,
        ollama: FakeOllama | None = None,
        web_dir: Path | None = None,
    ) -> GatewayClient:
        fake_ollama = ollama if ollama is not None else FakeOllama()
        chat_backend = OllamaChatBackend(
            "http://ollama", read_timeout=5, transport=fake_ollama.transport
        )
        chat_backends.append(chat_backend)
        fake = backend if backend is not None else FakeTranscriptionBackend()
        settings = Settings(
            _env_file=None,
            device="cpu",
            api_key=api_key,
            max_upload_mb=max_upload_mb,
            # без явного каталога — несуществующий: тесты не зависят от наличия сборки UI
            web_dir=web_dir if web_dir is not None else tmp_path / "no-web",
            data_dir=tmp_path / f"data-{len(clients)}",
        )
        registry = ModelRegistry.from_dict(copy.deepcopy(REGISTRY_DATA), default_ttl=600)
        factory: Callable[..., FakeTranscriptionBackend] = lambda _spec: fake  # noqa: E731
        manager = ModelManager(registry.whisper_specs(), factory)
        store = InMemoryTranscriptionStore()
        app = create_app(
            settings, registry=registry, manager=manager, chat_backend=chat_backend, store=store
        )
        await lifespans.enter_async_context(app.router.lifespan_context(app))
        # тестовые байты — не аудио: Opus кодирует фейк (настоящий — tests/test_opus.py)
        app.state.service._encode = fake_encode
        client = GatewayClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        client.backend = fake
        client.ollama = fake_ollama
        client.store = store
        client.app = app
        clients.append(client)
        return client

    yield _make
    for client in clients:
        await client.aclose()
    await lifespans.aclose()
    for chat_backend in chat_backends:
        await chat_backend.aclose()


@pytest.fixture(scope="session")
def postgres_url() -> Iterator[str]:
    """Настоящий PostgreSQL (`postgres:17-alpine`, локальный образ) с применёнными миграциями."""
    try:
        import docker

        docker.from_env().ping()
    except Exception as exc:  # Docker нет или он не запущен — PostgreSQL-тесты пропускаются
        pytest.skip(f"Docker недоступен: {exc}")
    from testcontainers.community.postgres import PostgresContainer

    from ai_gateway.db.engine import migrate

    with PostgresContainer("postgres:17-alpine", driver="psycopg") as container:
        url = container.get_connection_url()
        # env.py Alembic крутит свой asyncio.run — фикстура может подниматься внутри цикла теста
        with ThreadPoolExecutor(max_workers=1) as pool:
            pool.submit(migrate, url).result()
        yield url


@pytest.fixture
async def pg_engine(postgres_url: str) -> AsyncIterator[AsyncEngine]:
    """Движок к тестовой БД; после теста таблицы очищаются."""
    engine = create_engine(postgres_url)
    yield engine
    async with engine.begin() as connection:
        await connection.execute(text("TRUNCATE transcriptions CASCADE"))
    await engine.dispose()
