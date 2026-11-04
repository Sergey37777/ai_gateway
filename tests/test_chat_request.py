"""Модель запроса чата и его нормализация для Ollama."""

import pytest
from pydantic import ValidationError

from ai_gateway.chat import ChatCompletionRequest, normalize_request
from ai_gateway.errors import GatewayError
from ai_gateway.registry import OllamaSpec

SPEC = OllamaSpec(name="qwen3-14b", backend="ollama", model="qwen3:14b")
PNG_URL = "data:image/png;base64,iVBORw0KGgo="


def _request(**fields: object) -> ChatCompletionRequest:
    data: dict[str, object] = {
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": "привет"}],
    }
    data.update(fields)
    return ChatCompletionRequest.model_validate(data)


def _with_parts(parts: list[dict[str, object]]) -> ChatCompletionRequest:
    return _request(messages=[{"role": "user", "content": parts}])


def test_model_replaced() -> None:
    payload = normalize_request(_request(), SPEC)
    assert payload["model"] == "qwen3:14b"


def test_unknown_fields_pass_through() -> None:
    extra: dict[str, object] = {
        "temperature": 0.2,
        "max_tokens": 64,
        "tools": [{"type": "function", "function": {"name": "f"}}],
        "tool_choice": "auto",
        "reasoning_effort": "none",
        "stream_options": {"include_usage": True},
    }
    payload = normalize_request(_request(**extra), SPEC)
    for key, value in extra.items():
        assert payload[key] == value


def test_unset_fields_not_added() -> None:
    assert "stream" not in normalize_request(_request(), SPEC)


def test_keep_alive_dropped() -> None:
    # политику памяти задаёт только OLLAMA_KEEP_ALIVE контейнера, клиент её менять не может
    payload = normalize_request(_request(keep_alive=-1), SPEC)
    assert "keep_alive" not in payload


def test_tool_history_passes_through() -> None:
    messages: list[dict[str, object]] = [
        {"role": "user", "content": "2+3?"},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "add", "arguments": '{"a":2,"b":3}'},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_1", "content": "+5"},
    ]
    payload = normalize_request(_request(messages=messages), SPEC)
    assert payload["messages"] == messages


def test_text_parts_pass() -> None:
    parts: list[dict[str, object]] = [{"type": "text", "text": "привет"}]
    payload = normalize_request(_with_parts(parts), SPEC)
    assert payload["messages"] == [{"role": "user", "content": parts}]


def test_data_url_image_passes() -> None:
    parts: list[dict[str, object]] = [
        {"type": "text", "text": "что на картинке?"},
        {"type": "image_url", "image_url": {"url": PNG_URL}},
    ]
    payload = normalize_request(_with_parts(parts), SPEC)
    assert payload["messages"] == [{"role": "user", "content": parts}]


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/a.png",
        "http://10.0.0.1/a.png",
        "data:text/plain;base64,aGk=",
        "data:image/png,raw",
    ],
)
def test_non_data_image_rejected(url: str) -> None:
    with pytest.raises(GatewayError) as info:
        normalize_request(_with_parts([{"type": "image_url", "image_url": {"url": url}}]), SPEC)
    assert info.value.status_code == 400
    assert info.value.code == "invalid_image_url"
    assert info.value.param == "messages"


@pytest.mark.parametrize(
    "part",
    [{"type": "input_audio", "input_audio": {}}, {"type": "file", "file": {}}],
)
def test_unsupported_part_rejected(part: dict[str, object]) -> None:
    with pytest.raises(GatewayError) as info:
        normalize_request(_with_parts([part]), SPEC)
    assert info.value.status_code == 400
    assert info.value.code == "invalid_request_error"
    assert info.value.param == "messages"


def test_empty_messages_invalid() -> None:
    with pytest.raises(ValidationError):
        ChatCompletionRequest.model_validate({"model": "m", "messages": []})


def test_developer_mapped_to_system() -> None:
    request = _request(
        messages=[
            {"role": "developer", "content": "отвечай кратко"},
            {"role": "user", "content": "привет"},
        ]
    )
    payload = normalize_request(request, SPEC)
    assert payload["messages"] == [
        {"role": "system", "content": "отвечай кратко"},
        {"role": "user", "content": "привет"},
    ]
