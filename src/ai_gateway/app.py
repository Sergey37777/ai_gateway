"""Сборка FastAPI-приложения: lifespan, middleware, роутеры, логирование."""

import asyncio
import contextlib
import sys
import uuid
from collections.abc import AsyncIterator
from typing import TextIO

from fastapi import FastAPI
from loguru import logger
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from ai_gateway.api import audio, chat, health, models, ui
from ai_gateway.api.deps import api_key_valid, invalid_api_key
from ai_gateway.backends import build_backend
from ai_gateway.backends.base import ChatBackend
from ai_gateway.backends.ollama import OllamaChatBackend
from ai_gateway.config import (
    Settings,
    detect_cuda_device_count,
    resolve_compute_type,
    resolve_device,
)
from ai_gateway.errors import error_response, install_error_handlers, internal_error
from ai_gateway.lifecycle import ModelManager
from ai_gateway.registry import ModelRegistry
from ai_gateway.web import mount_web

TRANSCRIPTIONS_PATH = "/v1/audio/transcriptions"
CHAT_PATH = "/v1/chat/completions"
GUARDED_PATHS = frozenset({TRANSCRIPTIONS_PATH, CHAT_PATH})
MIB = 1024 * 1024
LOG_FORMAT = (
    "<green>{time:YYYY-MM-DD HH:mm:ss.SSS}</green> | <level>{level: <8}</level> | "
    "{extra[request_id]} | <cyan>{name}</cyan>:<cyan>{line}</cyan> - <level>{message}</level>"
)


def configure_logging(level: str, *, sink: TextIO | None = None) -> None:
    """loguru в `sink` (по умолчанию stderr); `request_id` вне запроса — `-`."""
    logger.remove()
    logger.configure(extra={"request_id": "-"})
    # diagnose=False: не печатать значения переменных в трейсбеках (ключи, содержимое запросов)
    logger.add(
        sink if sink is not None else sys.stderr,
        level=level.upper(),
        format=LOG_FORMAT,
        diagnose=False,
        colorize=False if sink is not None else None,
    )


class RequestContextMiddleware:
    """`X-Request-ID` в контексте логов и в каждом ответе; необработанные ошибки → 500.

    500 формируется здесь, а не в ServerErrorMiddleware Starlette: тот работает снаружи
    пользовательских middleware, и ответ ушёл бы без `X-Request-ID`.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        incoming = dict(scope["headers"]).get(b"x-request-id", b"").decode("latin-1").strip()
        request_id = incoming or uuid.uuid4().hex
        started = False

        async def send_with_id(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
                headers = [
                    (k, v) for k, v in message.get("headers", []) if k.lower() != b"x-request-id"
                ]
                headers.append((b"x-request-id", request_id.encode("latin-1")))
                message["headers"] = headers
            await send(message)

        with logger.contextualize(request_id=request_id):
            try:
                await self.app(scope, receive, send_with_id)
            except Exception:
                logger.exception("Необработанная ошибка")
                if started:
                    raise
                response = error_response(internal_error())
                await response(scope, receive, send_with_id)


class ApiKeyMiddleware:
    """Проверяет `Authorization: Bearer <key>` для `/v1/*`, если ключ задан.

    Именно middleware, а не зависимость FastAPI: зависимости выполняются после разбора
    multipart, и клиент без ключа успевал бы записать файл на диск.
    """

    def __init__(self, app: ASGIApp, *, api_key: str | None) -> None:
        self.app = app
        self.api_key = api_key

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if self.api_key and scope["type"] == "http" and scope["path"].startswith("/v1/"):
            authorization = dict(scope["headers"]).get(b"authorization", b"").decode("latin-1")
            if not api_key_valid(authorization, self.api_key):
                await error_response(invalid_api_key())(scope, receive, send)
                return
        await self.app(scope, receive, send)


class UploadSizeGuardMiddleware:
    """Ограничивает размер тела загрузки, не дочитывая лишнее.

    Нужен именно middleware: FastAPI разбирает multipart (и пишет файл на диск) до эндпоинта
    и зависимостей. При известном `Content-Length` отказ сразу; при chunked-передаче байты
    считаются по мере чтения, и при превышении клиент получает 413, а приложение — disconnect.
    """

    def __init__(self, app: ASGIApp, *, max_upload_mb: int) -> None:
        self.app = app
        self.max_upload_mb = max_upload_mb
        # запас 1 МиБ на multipart-обвязку и остальные поля формы
        self.max_body = max_upload_mb * MIB + MIB

    async def _reject(self, scope: Scope, receive: Receive, send: Send) -> None:
        error = (
            chat.request_too_large(self.max_upload_mb)
            if scope["path"] == CHAT_PATH
            else audio.file_too_large(self.max_upload_mb)
        )
        response = error_response(error)
        await response(scope, receive, send)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not (
            scope["type"] == "http" and scope["method"] == "POST" and scope["path"] in GUARDED_PATHS
        ):
            await self.app(scope, receive, send)
            return

        raw = dict(scope["headers"]).get(b"content-length")
        if raw is not None and raw.isdigit() and int(raw) > self.max_body:
            await self._reject(scope, receive, send)
            return

        received = 0
        rejected = False

        async def counting_receive() -> Message:
            nonlocal received, rejected
            if rejected:
                return {"type": "http.disconnect"}
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_body:
                    rejected = True
                    await self._reject(scope, receive, send)
                    # приложение видит обрыв соединения и прекращает разбор тела
                    return {"type": "http.disconnect"}
            return message

        async def guarded_send(message: Message) -> None:
            # ответ 413 уже отправлен — всё, что после него пишет приложение, отбрасывается
            if not rejected:
                await send(message)

        try:
            await self.app(scope, counting_receive, guarded_send)
        except Exception:
            if not rejected:
                raise


def create_app(
    settings: Settings | None = None,
    *,
    registry: ModelRegistry | None = None,
    manager: ModelManager | None = None,
    chat_backend: ChatBackend | None = None,
) -> FastAPI:
    """Фабрика приложения; реестр и менеджер можно внедрить (тесты с фейковым бэкендом)."""
    settings = settings if settings is not None else Settings()

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        configure_logging(settings.log_level)
        cuda_count = detect_cuda_device_count() if settings.device == "auto" else 0
        device = resolve_device(settings.device, cuda_count)
        compute_type = resolve_compute_type(settings.compute_type, device)
        app.state.device = device
        logger.info("Устройство: {}, compute_type: {}", device, compute_type)

        reg: ModelRegistry = app.state.registry or ModelRegistry.from_file(
            settings.models_file, default_ttl=settings.default_ttl
        )
        mgr: ModelManager = app.state.manager or ModelManager(
            reg.whisper_specs(),
            lambda spec: build_backend(spec, device=device, compute_type=compute_type),
        )
        app.state.registry, app.state.manager = reg, mgr
        # закрываем только созданный здесь бэкенд; внедрённый принадлежит вызывающему
        own_chat: OllamaChatBackend | None = None
        if app.state.chat_backend is None:
            own_chat = OllamaChatBackend(
                settings.ollama_url, read_timeout=settings.ollama_read_timeout
            )
            app.state.chat_backend = own_chat

        sweeper = asyncio.create_task(mgr.run_sweeper(settings.sweep_interval))
        try:
            yield
        finally:
            sweeper.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await sweeper
            await mgr.shutdown()
            if own_chat is not None:
                await own_chat.aclose()

    app = FastAPI(title="ai_gateway", lifespan=lifespan)
    app.state.settings = settings
    app.state.registry = registry
    app.state.manager = manager
    app.state.chat_backend = chat_backend
    # без lifespan (тесты) устройство берётся из настроек; lifespan уточняет его
    app.state.device = "cpu" if settings.device == "auto" else settings.device

    install_error_handlers(app)
    app.include_router(audio.router, prefix="/v1")
    app.include_router(chat.router, prefix="/v1")
    app.include_router(models.router, prefix="/v1")
    app.include_router(health.router)
    app.include_router(ui.router)
    # статика UI — последней: `/v1/*`, `/health`, `/ui/config` матчатся раньше
    mount_web(app, settings.web_dir)

    # последний добавленный middleware — внешний: request id оборачивает всё (включая 401/413),
    # ключ проверяется раньше, чем считается размер тела
    app.add_middleware(UploadSizeGuardMiddleware, max_upload_mb=settings.max_upload_mb)
    app.add_middleware(ApiKeyMiddleware, api_key=settings.api_key)
    app.add_middleware(RequestContextMiddleware)
    return app
