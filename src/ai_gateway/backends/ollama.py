"""Чат-бэкенд: HTTP-клиент к OpenAI-совместимому API Ollama и соответствие её ошибок."""

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from loguru import logger

from ai_gateway.backends.base import JsonObject
from ai_gateway.errors import GatewayError, model_unavailable
from ai_gateway.registry import OllamaSpec

# признаки нехватки памяти в тексте ошибки Ollama (сравнение по lower())
OOM_MARKERS: tuple[str, ...] = (
    "out of memory",
    "cudamalloc",
    "requires more system memory",
    "signal: killed",
    "llama-server process has terminated",
    "unexpected eof",
)

_CHAT_PATH = "/v1/chat/completions"
_PING_TIMEOUT = 2.0
_LOG_LIMIT = 500


def _bad_response() -> GatewayError:
    return GatewayError(502, "upstream_error", "Ollama вернула некорректный ответ")


def _map_transport_error(error: httpx.TransportError) -> GatewayError:
    """Ошибки соединения; ConnectTimeout (подкласс TimeoutException) проверяется раньше."""
    if isinstance(error, httpx.ConnectError | httpx.ConnectTimeout):
        return model_unavailable("Ollama недоступна")
    if isinstance(error, httpx.TimeoutException):
        return GatewayError(504, "upstream_timeout", "Ollama не ответила вовремя")
    return GatewayError(502, "upstream_error", "Соединение с Ollama прервано")


def _error_message(body: object, raw_text: str) -> str:
    """Сообщение из `{"error": {"message": ...}}` или `{"error": "..."}`, иначе текст тела."""
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, str):
            return error
        if isinstance(error, dict):
            message = error.get("message")
            if isinstance(message, str):
                return message
    return raw_text


def _is_oom(text: str) -> bool:
    lowered = text.lower()
    return any(marker in lowered for marker in OOM_MARKERS)


def _map_error(spec: OllamaSpec, status: int | None, message: str, raw: str) -> GatewayError:
    """Ошибка Ollama (HTTP-статус или чанк `error` посреди стрима) → ошибка шлюза."""
    if status == 404:
        return model_unavailable(
            f"Модель {spec.model} не скачана в Ollama: выполните `ollama pull {spec.model}`"
        )
    if status == 503 or _is_oom(message) or _is_oom(raw):
        return model_unavailable(f"Ollama не смогла выполнить запрос к модели {spec.model}")
    if status == 400:
        return GatewayError(400, "invalid_request_error", message)
    logger.warning("Ollama вернула ошибку: статус {}, тело {}", status, raw[:_LOG_LIMIT])
    return GatewayError(502, "upstream_error", "Ошибка Ollama")


def _error_from_response(spec: OllamaSpec, status: int, raw: str) -> GatewayError:
    try:
        body: object = json.loads(raw)
    except ValueError:
        body = None
    return _map_error(spec, status, _error_message(body, raw), raw)


def _parse_object(raw: str) -> JsonObject:
    """JSON-объект из строки; иначе 502."""
    try:
        parsed: object = json.loads(raw)
    except ValueError:
        parsed = None
    if not isinstance(parsed, dict):
        logger.warning("Некорректные данные от Ollama: {}", raw[:_LOG_LIMIT])
        raise _bad_response()
    return parsed


class OllamaChatBackend:
    """Прокси к `/v1/chat/completions` Ollama; тело ответа отдаётся как есть."""

    def __init__(
        self,
        base_url: str,
        *,
        read_timeout: float,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url,
            timeout=httpx.Timeout(connect=5.0, read=read_timeout, write=30.0, pool=5.0),
            transport=transport,
        )

    async def complete(self, spec: OllamaSpec, payload: JsonObject) -> JsonObject:
        try:
            response = await self._client.post(_CHAT_PATH, json=payload | {"stream": False})
        except httpx.TransportError as error:
            raise _map_transport_error(error) from error
        if response.status_code != 200:
            raise _error_from_response(spec, response.status_code, response.text)
        return _parse_object(response.text)

    @asynccontextmanager
    async def stream(
        self, spec: OllamaSpec, payload: JsonObject
    ) -> AsyncIterator[AsyncIterator[JsonObject]]:
        request = self._client.build_request("POST", _CHAT_PATH, json=payload | {"stream": True})
        try:
            response = await self._client.send(request, stream=True)
        except httpx.TransportError as error:
            raise _map_transport_error(error) from error
        try:
            if response.status_code != 200:
                try:
                    raw = (await response.aread()).decode("utf-8", errors="replace")
                except httpx.TransportError as error:
                    raise _map_transport_error(error) from error
                raise _error_from_response(spec, response.status_code, raw)
            yield self._chunks(spec, response)
        finally:
            await response.aclose()

    async def _chunks(
        self, spec: OllamaSpec, response: httpx.Response
    ) -> AsyncIterator[JsonObject]:
        try:
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue  # пустые строки и `:`-комментарии
                data = line.removeprefix("data:").strip()
                if data == "[DONE]":
                    return
                chunk = _parse_object(data)
                if "error" in chunk:
                    message = _error_message(chunk, data)
                    raise _map_error(spec, None, message, data)
                yield chunk
        except httpx.TransportError as error:
            raise _map_transport_error(error) from error

    async def ping(self) -> bool:
        try:
            response = await self._client.get("/api/version", timeout=_PING_TIMEOUT)
        except Exception:  # noqa: BLE001 — любая ошибка означает «недоступна»
            return False
        return response.status_code == 200

    async def aclose(self) -> None:
        await self._client.aclose()
