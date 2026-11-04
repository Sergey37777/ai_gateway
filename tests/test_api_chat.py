"""POST /v1/chat/completions: JSON, SSE, ошибки, лимиты, лог и OpenAI SDK."""

import asyncio
import copy
import io
import json
from collections.abc import AsyncIterator, MutableMapping
from typing import Any

import httpx
import httpx2
import openai
import pytest
from openai import AsyncOpenAI

from ai_gateway.api.chat import sse_events
from ai_gateway.app import configure_logging, create_app
from ai_gateway.backends.ollama import OllamaChatBackend
from ai_gateway.chat import ChunkNormalizer
from ai_gateway.config import Settings
from ai_gateway.lifecycle import ModelManager
from ai_gateway.registry import ModelRegistry, OllamaSpec
from tests.conftest import REGISTRY_DATA
from tests.fakes import (
    FIXTURES_DIR,
    FakeOllama,
    FakeTranscriptionBackend,
    TrackingStream,
    parse_sse,
)

MESSAGES = [{"role": "user", "content": "Привет"}]


def chat_body(**extra: object) -> dict[str, object]:
    return {"model": "gpt-4o-mini", "messages": MESSAGES} | extra


def sse_response(*events: str, fail_after: int | None = None) -> httpx.Response:
    data = "".join(f"data: {e}\n\n" for e in events).encode()
    return httpx.Response(
        200,
        headers={"content-type": "text/event-stream"},
        stream=TrackingStream(data, fail_after=fail_after),
    )


def events_of(text: str) -> list[str]:
    return [e for e in text.split("\n\n") if e]


async def test_complete(make_client):
    client = await make_client()
    client.ollama.queue_fixture("complete_basic")
    r = await client.post("/v1/chat/completions", json=chat_body())
    assert r.status_code == 200
    assert r.json()["model"] == "qwen3-14b"
    assert client.ollama.requests[0]["model"] == "qwen3:14b"


async def test_stream_sse_format(make_client):
    client = await make_client()
    client.ollama.queue_fixture("stream_basic")
    r = await client.post("/v1/chat/completions", json=chat_body(stream=True))
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    assert r.headers["cache-control"] == "no-cache"
    events = events_of(r.text)
    assert events[-1] == "data: [DONE]"
    assert all(e.startswith("data: ") for e in events)
    chunks = [json.loads(e.removeprefix("data: ")) for e in events[:-1]]
    assert chunks
    assert {c["model"] for c in chunks} == {"qwen3-14b"}


async def test_stream_error_before_start_is_json(make_client):
    client = await make_client()
    client.ollama.queue_fixture("error_model_not_found")
    r = await client.post("/v1/chat/completions", json=chat_body(stream=True))
    assert r.status_code == 503
    assert r.headers["content-type"].startswith("application/json")
    assert r.json()["error"]["code"] == "model_unavailable"
    assert r.headers["Retry-After"] == "30"


async def test_stream_error_mid_stream_event(make_client):
    client = await make_client()
    first = json.dumps(parse_sse((FIXTURES_DIR / "stream_basic.sse").read_bytes())[0])
    client.ollama.queue(sse_response(first, json.dumps({"error": {"message": "boom"}})))
    r = await client.post("/v1/chat/completions", json=chat_body(stream=True))
    assert r.status_code == 200
    events = events_of(r.text)
    assert "data: [DONE]" not in events
    assert json.loads(events[-1].removeprefix("data: "))["error"]["code"] == "upstream_error"


async def test_sse_close_closes_upstream():
    from contextlib import AsyncExitStack

    data = (FIXTURES_DIR / "stream_basic.sse").read_bytes()
    stream = TrackingStream(data)
    transport = httpx.MockTransport(
        lambda _r: httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=stream)
    )
    backend = OllamaChatBackend("http://ollama", read_timeout=5, transport=transport)
    spec = OllamaSpec(name="qwen3-14b", backend="ollama", model="qwen3:14b")
    stack = AsyncExitStack()
    chunks = await stack.enter_async_context(backend.stream(spec, {"messages": []}))
    agen = sse_events(chunks, ChunkNormalizer(spec), stack)
    first = await anext(agen)
    assert first.startswith(b"data: ")
    assert not stream.closed
    await agen.aclose()
    assert stream.closed
    await backend.aclose()


async def test_sse_close_logs_client_disconnected():
    from contextlib import AsyncExitStack

    sink = io.StringIO()
    configure_logging("INFO", sink=sink)

    async def chunks() -> AsyncIterator[dict[str, object]]:
        for i in range(10):
            yield {"id": str(i), "choices": []}

    spec = OllamaSpec(name="qwen3-14b", backend="ollama", model="qwen3:14b")
    agen = sse_events(chunks(), ChunkNormalizer(spec), AsyncExitStack(), model="qwen3-14b")
    await anext(agen)
    await agen.aclose()
    assert "итог=client_disconnected" in sink.getvalue()
    assert "итог=ok" not in sink.getvalue()


async def test_sse_complete_logs_ok():
    from contextlib import AsyncExitStack

    sink = io.StringIO()
    configure_logging("INFO", sink=sink)

    async def chunks() -> AsyncIterator[dict[str, object]]:
        yield {"id": "0", "choices": []}

    spec = OllamaSpec(name="qwen3-14b", backend="ollama", model="qwen3:14b")
    events = [e async for e in sse_events(chunks(), ChunkNormalizer(spec), AsyncExitStack())]
    assert events[-1] == b"data: [DONE]\n\n"
    assert "итог=ok" in sink.getvalue()


class SlowStream(TrackingStream):
    """Тот же поток, но с паузами между кусками — клиент успевает отключиться."""

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for start in range(0, len(self.data), 64):
            await asyncio.sleep(0.01)
            yield self.data[start : start + 64]


@pytest.mark.parametrize("disconnect_delay", [0.01, 0.2], ids=["before_headers", "mid_stream"])
async def test_client_disconnect_asgi_2_3_closes_upstream(disconnect_delay: float) -> None:
    """Прод-путь uvicorn (spec_version 2.3): обрыв клиента закрывает соединение с Ollama."""
    streams: list[SlowStream] = []

    async def handler(_request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0.05)  # Ollama грузит модель / обрабатывает промпт
        stream = SlowStream((FIXTURES_DIR / "stream_reasoning.sse").read_bytes())
        streams.append(stream)
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=stream)

    registry = ModelRegistry.from_dict(copy.deepcopy(REGISTRY_DATA), default_ttl=600)
    manager = ModelManager(registry.whisper_specs(), lambda _spec: FakeTranscriptionBackend())
    backend = OllamaChatBackend(
        "http://ollama", read_timeout=5, transport=httpx.MockTransport(handler)
    )
    app = create_app(
        Settings(_env_file=None, device="cpu"),
        registry=registry,
        manager=manager,
        chat_backend=backend,
    )
    body = json.dumps({"model": "qwen3-14b", "stream": True, "messages": MESSAGES}).encode()
    body_sent = False
    disconnected = asyncio.Event()
    asyncio.get_running_loop().call_later(disconnect_delay, disconnected.set)

    async def receive() -> dict[str, object]:
        nonlocal body_sent
        if not body_sent:
            body_sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        await disconnected.wait()
        return {"type": "http.disconnect"}

    sent: list[str] = []

    async def send(message: MutableMapping[str, Any]) -> None:
        sent.append(str(message["type"]))

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "path": "/v1/chat/completions",
        "raw_path": b"/v1/chat/completions",
        "query_string": b"",
        "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
        ],
        "scheme": "http",
        "server": ("test", 80),
        "client": ("test", 1),
        "root_path": "",
        "app": None,
        "state": {},
    }
    try:
        await app(scope, receive, send)
        # без ожидания сборщика мусора: закрытие должно быть детерминированным
        assert [s.closed for s in streams] == [True] * len(streams)
        if disconnect_delay > 0.1:
            assert streams, "поток Ollama должен был открыться"
    finally:
        await backend.aclose()


async def test_unknown_model_404(make_client):
    client = await make_client()
    r = await client.post("/v1/chat/completions", json=chat_body(model="nope"))
    assert r.status_code == 404


async def test_whisper_model_in_chat_400(make_client):
    client = await make_client()
    r = await client.post("/v1/chat/completions", json=chat_body(model="whisper-1"))
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "model_not_supported"


async def test_missing_messages_400(make_client):
    client = await make_client()
    r = await client.post("/v1/chat/completions", json={"model": "qwen3-14b"})
    assert r.status_code == 400
    assert r.json()["error"]["param"] == "messages"


async def test_invalid_image_url_400(make_client):
    client = await make_client()
    content = [{"type": "image_url", "image_url": {"url": "ftp://x/y.png"}}]
    r = await client.post(
        "/v1/chat/completions",
        json=chat_body(messages=[{"role": "user", "content": content}]),
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "invalid_image_url"
    assert client.ollama.requests == []


async def test_chat_requires_auth(make_client):
    client = await make_client(api_key="k")
    r = await client.post("/v1/chat/completions", json=chat_body())
    assert r.status_code == 401


async def test_chat_body_too_large_413(make_client):
    client = await make_client(max_upload_mb=1)
    big = "x" * (2 * 1024 * 1024)
    r = await client.post(
        "/v1/chat/completions", json=chat_body(messages=[{"role": "user", "content": big}])
    )
    assert r.status_code == 413
    assert r.json()["error"]["code"] == "request_too_large"
    assert "1 МБ" in r.json()["error"]["message"]
    assert client.ollama.requests == []


async def test_chat_log_has_no_prompt(make_client):
    client = await make_client()
    sink = io.StringIO()
    configure_logging("INFO", sink=sink)
    client.ollama.queue_fixture("complete_basic")
    prompt = "секретный-промпт-42"
    r = await client.post(
        "/v1/chat/completions",
        json=chat_body(messages=[{"role": "user", "content": prompt}]),
    )
    assert r.status_code == 200
    out = sink.getvalue()
    assert "Чат: модель=qwen3-14b" in out
    assert prompt not in out
    assert r.json()["choices"][0]["message"]["content"] not in out


@pytest.fixture
def sdk_ollama() -> FakeOllama:
    return FakeOllama()


@pytest.fixture
async def sdk_client(sdk_ollama: FakeOllama) -> AsyncIterator[AsyncOpenAI]:
    import copy

    from ai_gateway.lifecycle import ModelManager
    from ai_gateway.registry import ModelRegistry

    registry = ModelRegistry.from_dict(copy.deepcopy(REGISTRY_DATA), default_ttl=600)
    backend = OllamaChatBackend("http://ollama", read_timeout=5, transport=sdk_ollama.transport)
    app = create_app(
        Settings(_env_file=None, device="cpu"),
        registry=registry,
        manager=ModelManager(registry.whisper_specs(), lambda _spec: None),  # type: ignore[arg-type,return-value]
        chat_backend=backend,
    )
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app), base_url="http://test"
    ) as http_client:
        yield AsyncOpenAI(base_url="http://test/v1", api_key="x", http_client=http_client)
    await backend.aclose()


async def test_sdk_stream_tool_call(sdk_client, sdk_ollama):
    sdk_ollama.queue_fixture("stream_tool_call")
    stream = await sdk_client.chat.completions.create(
        model="qwen3-14b", messages=MESSAGES, stream=True
    )
    names: list[str] = []
    finish: list[str] = []
    async for chunk in stream:
        for choice in chunk.choices:
            for call in choice.delta.tool_calls or []:
                if call.function and call.function.name:
                    names.append(call.function.name)
            if choice.finish_reason:
                finish.append(choice.finish_reason)
    assert names == ["get_weather"]
    assert finish == ["tool_calls"]


async def test_sdk_error_event_raises(sdk_client, sdk_ollama):
    first = json.dumps(parse_sse((FIXTURES_DIR / "stream_basic.sse").read_bytes())[0])
    sdk_ollama.queue(sse_response(first, json.dumps({"error": {"message": "boom"}})))
    stream = await sdk_client.chat.completions.create(
        model="qwen3-14b", messages=MESSAGES, stream=True
    )
    with pytest.raises(openai.APIError):
        async for _ in stream:
            pass


async def test_sse_response_closes_generator_on_send_failure():
    # обрыв клиента: send падает посреди стрима; генератор (и соединение с Ollama)
    # должен закрыться сразу, а не ждать сборщика мусора — ссылка на него удерживается
    from contextlib import AsyncExitStack

    from ai_gateway.api.chat import SseResponse

    closed = False
    stack = AsyncExitStack()

    async def closer() -> None:
        nonlocal closed
        closed = True

    stack.push_async_callback(closer)

    async def chunks() -> AsyncIterator[dict[str, object]]:
        for i in range(10):
            yield {"id": str(i), "choices": []}

    spec = OllamaSpec(name="qwen3-14b", backend="ollama", model="qwen3:14b")
    agen = sse_events(chunks(), ChunkNormalizer(spec), stack)
    response = SseResponse(agen, media_type="text/event-stream")
    sent = 0

    async def send(_message: object) -> None:
        nonlocal sent
        sent += 1
        if sent == 3:
            raise OSError("клиент отключился")

    async def receive() -> dict[str, str]:
        return {"type": "http.disconnect"}

    with pytest.raises(Exception):  # noqa: B017, PT011 — ClientDisconnect или OSError
        await response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send)
    assert closed
