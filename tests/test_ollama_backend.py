"""OllamaChatBackend: HTTP-клиент к Ollama и соответствие ошибок (на фейке без сети)."""

import json
from collections.abc import AsyncIterator

import httpx
import pytest

from ai_gateway.backends.base import JsonObject
from ai_gateway.backends.ollama import OllamaChatBackend
from ai_gateway.errors import GatewayError
from ai_gateway.registry import OllamaSpec
from tests.fakes import FIXTURES_DIR, FakeOllama, TrackingStream, load_ollama_fixture, parse_sse

SPEC = OllamaSpec(name="qwen", backend="ollama", model="qwen3:14b")
PAYLOAD: JsonObject = {"model": "qwen3:14b", "messages": [{"role": "user", "content": "привет"}]}


@pytest.fixture
async def fake() -> FakeOllama:
    return FakeOllama()


@pytest.fixture
async def backend(fake: FakeOllama) -> AsyncIterator[OllamaChatBackend]:
    instance = OllamaChatBackend("http://ollama:11434", read_timeout=30.0, transport=fake.transport)
    yield instance
    await instance.aclose()


async def _stream_all(backend: OllamaChatBackend) -> list[JsonObject]:
    async with backend.stream(SPEC, PAYLOAD) as chunks:
        return [chunk async for chunk in chunks]


async def test_complete_returns_body(fake: FakeOllama, backend: OllamaChatBackend) -> None:
    fake.queue_fixture("complete_basic")
    result = await backend.complete(SPEC, PAYLOAD)
    expected = json.loads(load_ollama_fixture("complete_basic").content)
    assert result == expected
    assert fake.requests[0]["stream"] is False
    assert fake.requests[0]["model"] == "qwen3:14b"


async def test_stream_yields_chunks(fake: FakeOllama, backend: OllamaChatBackend) -> None:
    fake.queue_fixture("stream_basic")
    chunks = await _stream_all(backend)
    expected = parse_sse(await _fixture_bytes("stream_basic"))
    assert chunks == expected
    assert fake.requests[0]["stream"] is True


async def _fixture_bytes(name: str) -> bytes:
    return (FIXTURES_DIR / f"{name}.sse").read_bytes()


async def test_stream_closes_response_on_exit(fake: FakeOllama, backend: OllamaChatBackend) -> None:
    tracking = TrackingStream(await _fixture_bytes("stream_basic"))
    fake.queue(httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=tracking))
    async with backend.stream(SPEC, PAYLOAD) as chunks:
        await anext(chunks)
        assert not tracking.closed
    assert tracking.closed


async def test_stream_error_before_yield(fake: FakeOllama, backend: OllamaChatBackend) -> None:
    fake.queue_fixture("error_model_not_found")
    with pytest.raises(GatewayError) as info:
        async with backend.stream(SPEC, PAYLOAD):
            pytest.fail("тело не должно начаться")
    assert info.value.status_code == 503
    assert "ollama pull qwen3:14b" in info.value.message


ERROR_CASES = [
    (httpx.ConnectError("x"), 503, "model_unavailable"),
    (httpx.ConnectTimeout("x"), 503, "model_unavailable"),
    (httpx.ReadTimeout("x"), 504, "upstream_timeout"),
    (httpx.RemoteProtocolError("x"), 502, "upstream_error"),
    ("error_model_not_found", 503, "model_unavailable"),
    ("error_tools_unsupported", 400, "invalid_request_error"),
    (
        httpx.Response(500, json={"error": {"message": "CUDA error: out of memory"}}),
        503,
        "model_unavailable",
    ),
    (
        httpx.Response(
            500,
            json={"error": {"message": "llama-server process has terminated: signal: killed"}},
        ),
        503,
        "model_unavailable",
    ),
    (httpx.Response(503, json={"error": "server busy"}), 503, "model_unavailable"),
    (httpx.Response(500, text="boom"), 502, "upstream_error"),
]


@pytest.mark.parametrize(("item", "status", "code"), ERROR_CASES)
@pytest.mark.parametrize("streaming", [False, True])
async def test_error_mapping(
    fake: FakeOllama,
    backend: OllamaChatBackend,
    item: httpx.Response | Exception | str,
    status: int,
    code: str,
    streaming: bool,
) -> None:
    if isinstance(item, str):
        fake.queue_fixture(item)
    else:
        fake.queue(item)
    with pytest.raises(GatewayError) as info:
        if streaming:
            await _stream_all(backend)
        else:
            await backend.complete(SPEC, PAYLOAD)
    assert info.value.status_code == status
    assert info.value.code == code
    if status == 503:
        assert info.value.headers == {"Retry-After": "30"}


async def test_400_message_from_ollama(fake: FakeOllama, backend: OllamaChatBackend) -> None:
    fake.queue_fixture("error_tools_unsupported")
    with pytest.raises(GatewayError) as info:
        await backend.complete(SPEC, PAYLOAD)
    assert "does not support tools" in info.value.message


async def test_stream_error_chunk_mid_stream(fake: FakeOllama, backend: OllamaChatBackend) -> None:
    first = (await _fixture_bytes("stream_basic")).split(b"\n\n")[0]
    data = first + b'\n\ndata: {"error": {"message": "boom"}}\n\n'
    fake.queue(httpx.Response(200, stream=TrackingStream(data)))
    seen: list[JsonObject] = []
    with pytest.raises(GatewayError) as info:
        async with backend.stream(SPEC, PAYLOAD) as chunks:
            async for chunk in chunks:
                seen.append(chunk)
    assert len(seen) == 1
    assert info.value.status_code == 502
    assert info.value.code == "upstream_error"


async def test_stream_error_chunk_oom(fake: FakeOllama, backend: OllamaChatBackend) -> None:
    data = b'data: {"error": {"message": "unexpected EOF"}}\n\n'
    fake.queue(httpx.Response(200, stream=TrackingStream(data)))
    with pytest.raises(GatewayError) as info:
        await _stream_all(backend)
    assert info.value.code == "model_unavailable"


async def test_stream_connection_lost_mid_stream(
    fake: FakeOllama, backend: OllamaChatBackend
) -> None:
    tracking = TrackingStream(await _fixture_bytes("stream_basic"), fail_after=1)
    fake.queue(httpx.Response(200, stream=tracking))
    with pytest.raises(GatewayError) as info:
        await _stream_all(backend)
    assert info.value.status_code == 502
    assert info.value.code == "upstream_error"
    assert tracking.closed


@pytest.mark.parametrize("line", [b"data: {oops\n\n", b"data: [1, 2]\n\n"])
async def test_stream_malformed_data(
    fake: FakeOllama, backend: OllamaChatBackend, line: bytes
) -> None:
    tracking = TrackingStream(line)
    fake.queue(httpx.Response(200, stream=tracking))
    with pytest.raises(GatewayError) as info:
        await _stream_all(backend)
    assert info.value.status_code == 502
    assert info.value.message == "Ollama вернула некорректный ответ"
    assert tracking.closed


@pytest.mark.parametrize("body", ["not json", "[1]"])
async def test_complete_malformed_body(
    fake: FakeOllama, backend: OllamaChatBackend, body: str
) -> None:
    fake.queue(httpx.Response(200, text=body))
    with pytest.raises(GatewayError) as info:
        await backend.complete(SPEC, PAYLOAD)
    assert info.value.status_code == 502
    assert info.value.message == "Ollama вернула некорректный ответ"


async def test_stream_skips_comments_and_stops_at_done(
    fake: FakeOllama, backend: OllamaChatBackend
) -> None:
    data = b': keepalive\n\ndata: {"a": 1}\n\ndata: [DONE]\n\ndata: {"b": 2}\n\n'
    fake.queue(httpx.Response(200, stream=TrackingStream(data)))
    assert await _stream_all(backend) == [{"a": 1}]


async def test_ping() -> None:
    for up in (True, False):
        fake = FakeOllama(up=up)
        backend = OllamaChatBackend(
            "http://ollama:11434", read_timeout=30.0, transport=fake.transport
        )
        try:
            assert await backend.ping() is up
        finally:
            await backend.aclose()
