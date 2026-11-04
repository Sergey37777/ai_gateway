"""Нормализация ответов и чанков Ollama на записанных фикстурах."""

from ai_gateway.backends.base import JsonObject
from ai_gateway.chat import ChunkNormalizer, normalize_completion
from ai_gateway.registry import OllamaSpec
from tests.fakes import FIXTURES_DIR, load_ollama_fixture, parse_sse

SPEC = OllamaSpec(name="qwen3-14b", backend="ollama", model="qwen3:14b")


def _completion(name: str) -> JsonObject:
    body = load_ollama_fixture(name).json()
    assert isinstance(body, dict)
    return normalize_completion(body, SPEC)


def _stream(name: str) -> list[JsonObject]:
    normalizer = ChunkNormalizer(SPEC)
    raw = (FIXTURES_DIR / f"{name}.sse").read_bytes()
    return [normalizer(chunk) for chunk in parse_sse(raw)]


def _deltas(chunks: list[JsonObject]) -> list[JsonObject]:
    result: list[JsonObject] = []
    for chunk in chunks:
        choices = chunk["choices"]
        assert isinstance(choices, list)
        for choice in choices:
            assert isinstance(choice, dict)
            delta = choice["delta"]
            assert isinstance(delta, dict)
            result.append(delta)
    return result


def _first_message(body: JsonObject) -> JsonObject:
    choices = body["choices"]
    assert isinstance(choices, list)
    choice = choices[0]
    assert isinstance(choice, dict)
    message = choice["message"]
    assert isinstance(message, dict)
    return message


def _tool_calls(delta_or_message: JsonObject) -> list[JsonObject]:
    calls = delta_or_message.get("tool_calls")
    assert isinstance(calls, list)
    return [call for call in calls if isinstance(call, dict)]


def test_fixture_helpers_smoke():
    raw = (FIXTURES_DIR / "stream_basic.sse").read_bytes()
    assert len(parse_sse(raw)) > 1


def test_basic_completion_model_renamed():
    original = load_ollama_fixture("complete_basic").json()
    body = _completion("complete_basic")
    assert body["model"] == "qwen3-14b"
    for key in ("id", "created", "usage"):
        assert body[key] == original[key]


def test_stream_chunks_model_renamed():
    chunks = _stream("stream_basic")
    assert chunks
    assert all(chunk["model"] == "qwen3-14b" for chunk in chunks)


def test_reasoning_content_completion():
    message = _first_message(_completion("complete_reasoning"))
    reasoning = message["reasoning_content"]
    assert isinstance(reasoning, str) and reasoning
    assert "reasoning" not in message


def test_reasoning_content_stream():
    deltas = _deltas(_stream("stream_reasoning"))
    assert any(delta.get("reasoning_content") for delta in deltas)
    assert all("reasoning" not in delta for delta in deltas)


def test_existing_reasoning_content_left_alone():
    body: JsonObject = {
        "model": "x",
        "choices": [{"index": 0, "message": {"reasoning_content": "a", "reasoning": "b"}}],
    }
    message = _first_message(normalize_completion(body, SPEC))
    assert message["reasoning_content"] == "a"


def test_tool_call_completion_contract():
    body = _completion("complete_tool_call")
    call = _tool_calls(_first_message(body))[0]
    assert call["index"] == 0
    assert isinstance(call["id"], str) and call["id"].startswith("call")
    assert call["type"] == "function"
    function = call["function"]
    assert isinstance(function, dict) and function["name"] == "get_weather"
    choices = body["choices"]
    assert isinstance(choices, list) and isinstance(choices[0], dict)
    assert choices[0]["finish_reason"] == "tool_calls"


def test_tool_call_stream_contract():
    chunks = _stream("stream_tool_call")
    with_calls = [d for d in _deltas(chunks) if d.get("tool_calls")]
    call = _tool_calls(with_calls[0])[0]
    assert call["id"] and call["type"] == "function"
    function = call["function"]
    assert isinstance(function, dict) and function["name"] == "get_weather"
    last_choices = chunks[-1]["choices"]
    assert isinstance(last_choices, list) and isinstance(last_choices[0], dict)
    assert last_choices[0]["finish_reason"] == "tool_calls"


def test_parallel_tool_calls_stable_ids():
    ids_by_index: dict[object, set[object]] = {}
    occurrences: dict[object, int] = {}
    for delta in _deltas(_stream("stream_parallel_tool_calls")):
        if not delta.get("tool_calls"):
            continue
        for call in _tool_calls(delta):
            index = call["index"]
            call_id = call.get("id")
            if call_id:
                ids_by_index.setdefault(index, set()).add(call_id)
                occurrences[call_id] = occurrences.get(call_id, 0) + 1
    assert set(ids_by_index) == {0, 1}
    assert all(len(ids) == 1 for ids in ids_by_index.values())
    assert ids_by_index[0] != ids_by_index[1]
    assert all(count == 1 for count in occurrences.values())


def test_usage_chunk_passes():
    original = parse_sse((FIXTURES_DIR / "stream_usage.sse").read_bytes())[-1]
    last = _stream("stream_usage")[-1]
    assert last["choices"] == []
    assert last["usage"] == original["usage"]
    assert last["timings"] == original["timings"]
