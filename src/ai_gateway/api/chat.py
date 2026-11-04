"""POST /v1/chat/completions — чат, совместимый с OpenAI (прокси к Ollama, JSON и SSE)."""

import json
import time
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import AsyncExitStack
from typing import Annotated, Any

import anyio
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from loguru import logger
from starlette.responses import Response, StreamingResponse
from starlette.types import Send

from ai_gateway.api.deps import get_chat_backend, get_registry
from ai_gateway.backends.base import ChatBackend, JsonObject
from ai_gateway.chat import (
    ChatCompletionRequest,
    ChunkNormalizer,
    normalize_completion,
    normalize_request,
)
from ai_gateway.errors import GatewayError, internal_error
from ai_gateway.registry import ModelRegistry

router = APIRouter()

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


def request_too_large(max_upload_mb: int) -> GatewayError:
    return GatewayError(413, "request_too_large", f"Тело запроса больше {max_upload_mb} МБ")


def _tokens(usage: object, key: str) -> str:
    if isinstance(usage, dict):
        value = usage.get(key)
        if isinstance(value, int):
            return str(value)
    return "-"


def _log_chat(model: str, *, stream: bool, started: float, usage: object, outcome: str) -> None:
    # только метаданные: текст промптов и ответов в лог не попадает
    logger.info(
        "Чат: модель={}, stream={}, {:.1f} с, токены={}→{}, итог={}",
        model,
        stream,
        time.monotonic() - started,
        _tokens(usage, "prompt_tokens"),
        _tokens(usage, "completion_tokens"),
        outcome,
    )


def _event(payload: object) -> bytes:
    return b"data: " + json.dumps(payload, ensure_ascii=False).encode() + b"\n\n"


async def sse_events(
    chunks: AsyncIterator[JsonObject],
    normalize: ChunkNormalizer,
    stack: AsyncExitStack,
    *,
    model: str = "-",
    started: float | None = None,
) -> AsyncGenerator[bytes]:
    """Чанки Ollama → SSE; ошибка в середине потока — событие `error` без `[DONE]`."""
    started = time.monotonic() if started is None else started
    usage: object = None
    # пока [DONE] не отправлен, любое завершение (aclose при обрыве клиента) — отключение
    outcome = "client_disconnected"
    try:
        async for chunk in chunks:
            if chunk.get("usage"):
                usage = chunk["usage"]
            yield _event(normalize(chunk))
        yield b"data: [DONE]\n\n"
        outcome = "ok"
    except GatewayError as error:
        outcome = error.code
        yield _event(error.to_body())
    except Exception:
        logger.exception("Сбой при стриминге чата")
        outcome = "internal_error"
        yield _event(internal_error().to_body())
    finally:
        # сюда же попадаем при aclose() (обрыв клиента): закрывает соединение с Ollama
        # под shield: при обрыве клиента (ASGI 2.3) scope уже отменён, закрытие не должно прерваться
        try:
            with anyio.CancelScope(shield=True):
                await stack.aclose()
        finally:
            _log_chat(model, stream=True, started=started, usage=usage, outcome=outcome)


class SseResponse(StreamingResponse):
    """StreamingResponse, детерминированно закрывающий генератор.

    Starlette при обрыве клиента/отмене прерывает `async for` внутри `stream_response`, а
    сам генератор остаётся приостановленным на `yield` и закрывается лишь сборщиком мусора
    (asyncgen-хук цикла). Здесь он закрывается явно, под shield — отмена не прервёт `aclose`.
    """

    def __init__(self, content: AsyncGenerator[bytes], **kwargs: Any) -> None:  # noqa: ANN401
        # kwargs пробрасываются в StreamingResponse как есть (media_type, headers, ...)
        super().__init__(content, **kwargs)
        self._generator = content

    async def stream_response(self, send: Send) -> None:
        try:
            await super().stream_response(send)
        finally:
            with anyio.CancelScope(shield=True):
                await self._generator.aclose()


@router.post("/chat/completions")
async def chat_completions(
    body: ChatCompletionRequest,
    registry: Annotated[ModelRegistry, Depends(get_registry)],
    backend: Annotated[ChatBackend, Depends(get_chat_backend)],
) -> Response:
    spec = registry.resolve(body.model, "chat")
    payload = normalize_request(body, spec)
    started = time.monotonic()
    if not body.stream:
        try:
            result = normalize_completion(await backend.complete(spec, payload), spec)
        except GatewayError as error:
            _log_chat(spec.name, stream=False, started=started, usage=None, outcome=error.code)
            raise
        _log_chat(spec.name, stream=False, started=started, usage=result.get("usage"), outcome="ok")
        return JSONResponse(result)

    stack = AsyncExitStack()
    try:
        chunks = await stack.enter_async_context(backend.stream(spec, payload))
    except GatewayError as error:
        # ошибка до начала потока — обычный JSON-ответ с кодом статуса
        _log_chat(spec.name, stream=True, started=started, usage=None, outcome=error.code)
        raise
    return SseResponse(
        sse_events(chunks, ChunkNormalizer(spec), stack, model=spec.name, started=started),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )
