"""Запрос чата (`/v1/chat/completions`) и его нормализация для Ollama.

Факты проверки Ollama 0.40.8 (этап 2, задача 1), на которых основан модуль:
1. `keep_alive` в теле запроса принимается, но на этапе 2 не используется.
2. Рассуждения приходят в поле `reasoning`; `reasoning_effort: "none"` отключает их.
3. У tool_calls есть `id`/`index`, `finish_reason` корректный (`tool_calls`).
4. `stream_options.include_usage` работает (usage-чанк перед `[DONE]`).
5. Роль `developer` принимается без ошибки, но малая модель её игнорирует,
   поэтому она заменяется на `system`.
6. Ошибки приходят в формате OpenAI; нехватка памяти — HTTP 500 `api_error`.

Остальные поля запроса (temperature, tools, stream_options, ...) передаются как есть.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from ai_gateway.backends.base import JsonObject
from ai_gateway.errors import GatewayError
from ai_gateway.registry import OllamaSpec


class ChatMessage(BaseModel):
    """Сообщение чата; неизвестные поля (tool_calls, tool_call_id, ...) сохраняются."""

    model_config = ConfigDict(extra="allow")

    role: Literal["system", "developer", "user", "assistant", "tool"]
    content: str | list[dict[str, object]] | None = None


class ChatCompletionRequest(BaseModel):
    """Тело запроса чата; неизвестные поля пробрасываются в Ollama без изменений."""

    model_config = ConfigDict(extra="allow")

    model: str
    messages: list[ChatMessage] = Field(min_length=1)
    stream: bool = False


def _invalid_part(code: str, message: str) -> GatewayError:
    return GatewayError(400, code, message, param="messages")


def _check_part(part: dict[str, object]) -> None:
    part_type = part.get("type")
    if part_type == "text":
        return
    if part_type == "image_url":
        image = part.get("image_url")
        url = image.get("url") if isinstance(image, dict) else None
        if not (isinstance(url, str) and url.startswith("data:image/") and ";base64," in url):
            raise _invalid_part(
                "invalid_image_url", "Поддерживаются только картинки в виде base64 data URL"
            )
        return
    raise _invalid_part(
        "invalid_request_error", f"Тип части content '{part_type}' не поддерживается"
    )


def normalize_request(request: ChatCompletionRequest, spec: OllamaSpec) -> JsonObject:
    """Тело запроса для Ollama: имя модели из реестра, проверенный content, роль system."""
    for message in request.messages:
        if isinstance(message.content, list):
            for part in message.content:
                _check_part(part)

    payload: JsonObject = request.model_dump(exclude_unset=True)
    payload["model"] = spec.model
    messages = payload["messages"]
    assert isinstance(messages, list)
    for message in messages:
        if isinstance(message, dict) and message.get("role") == "developer":
            message["role"] = "system"
    return payload
