"""Сборка FastAPI-приложения: lifespan, middleware, роутеры, логирование."""

import asyncio
import contextlib
import sys
import uuid
from collections.abc import AsyncIterator

from fastapi import Depends, FastAPI
from loguru import logger
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from ai_gateway.api import audio, health, models
from ai_gateway.api.deps import require_api_key
from ai_gateway.backends import build_backend
from ai_gateway.config import (
    Settings,
    detect_cuda_device_count,
    resolve_compute_type,
    resolve_device,
)
from ai_gateway.errors import error_response, install_error_handlers, internal_error
from ai_gateway.lifecycle import ModelManager
from ai_gateway.registry import ModelRegistry

TRANSCRIPTIONS_PATH = "/v1/audio/transcriptions"
MIB = 1024 * 1024
LOG_FORMAT = (
    "<green>{time:YYYY-MM-DD HH:mm:ss.SSS}</green> | <level>{level: <8}</level> | "
    "{extra[request_id]} | <cyan>{name}</cyan>:<cyan>{line}</cyan> - <level>{message}</level>"
)


def configure_logging(level: str) -> None:
    """loguru в stderr; `request_id` по умолчанию — `-` (вне запроса)."""
    logger.remove()
    logger.configure(extra={"request_id": "-"})
    # diagnose=False: не печатать значения переменных в трейсбеках (ключи, содержимое запросов)
    logger.add(sys.stderr, level=level.upper(), format=LOG_FORMAT, diagnose=False)


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
        response = error_response(audio.file_too_large(self.max_upload_mb))
        await response(scope, receive, send)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not (
            scope["type"] == "http"
            and scope["method"] == "POST"
            and scope["path"] == TRANSCRIPTIONS_PATH
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
            reg.specs(),
            lambda spec: build_backend(spec, device=device, compute_type=compute_type),
        )
        app.state.registry, app.state.manager = reg, mgr

        sweeper = asyncio.create_task(mgr.run_sweeper(settings.sweep_interval))
        try:
            yield
        finally:
            sweeper.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await sweeper
            await mgr.shutdown()

    app = FastAPI(title="ai_gateway", lifespan=lifespan)
    app.state.settings = settings
    app.state.registry = registry
    app.state.manager = manager
    # без lifespan (тесты) устройство берётся из настроек; lifespan уточняет его
    app.state.device = "cpu" if settings.device == "auto" else settings.device

    install_error_handlers(app)
    v1 = [Depends(require_api_key)]
    app.include_router(audio.router, prefix="/v1", dependencies=v1)
    app.include_router(models.router, prefix="/v1", dependencies=v1)
    app.include_router(health.router)

    # последний добавленный middleware — внешний: request id оборачивает всё, включая 413
    app.add_middleware(UploadSizeGuardMiddleware, max_upload_mb=settings.max_upload_mb)
    app.add_middleware(RequestContextMiddleware)
    return app
