from collections.abc import AsyncIterator
from dataclasses import replace
from typing import Any

import httpx
import pytest

from ai_gateway.backends.base import TranscriptionOptions, Word
from ai_gateway.errors import GatewayError
from tests.fakes import FakeTranscriptionBackend, make_result

URL = "/v1/audio/transcriptions"
FILES = {"file": ("a.wav", b"RIFF....", "audio/wav")}


def _error(response: httpx.Response) -> dict[str, Any]:
    error: dict[str, Any] = response.json()["error"]
    return error


async def test_json_default(make_client):
    client = await make_client()
    r = await client.post(URL, data={"model": "whisper-1"}, files=FILES)
    assert r.status_code == 200
    assert r.json() == {"text": "привет мир"}
    assert client.backend.load_calls == 1


async def test_empty_model_uses_default(make_client):
    client = await make_client()
    r = await client.post(URL, data={"model": ""}, files=FILES)
    assert r.status_code == 200
    assert r.json() == {"text": "привет мир"}


@pytest.mark.parametrize(
    ("fmt", "media_type", "prefix"),
    [
        ("text", "text/plain", "привет мир"),
        ("srt", "text/plain", "1\n00:00:00,000 --> 00:00:01,000\n"),
        ("vtt", "text/plain", "WEBVTT\n\n"),
        ("verbose_json", "application/json", '{"task":"transcribe"'),
    ],
)
async def test_formats(make_client, fmt, media_type, prefix):
    client = await make_client()
    r = await client.post(URL, data={"model": "whisper-1", "response_format": fmt}, files=FILES)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith(media_type)
    assert r.text.startswith(prefix)


async def test_word_granularity_sets_option(make_client):
    result = make_result()
    words = [Word(word=" привет", start=0.0, end=0.5)]
    backend = FakeTranscriptionBackend(result=replace(result, words=words))
    client = await make_client(backend=backend)
    data = {
        "model": "whisper-1",
        "response_format": "verbose_json",
        "timestamp_granularities[]": ["word", "segment"],
    }
    r = await client.post(URL, data=data, files=FILES)
    assert r.status_code == 200
    assert backend.last_options is not None
    assert backend.last_options.word_timestamps is True
    assert r.json()["words"] == [{"word": " привет", "start": 0.0, "end": 0.5}]


async def test_segment_granularity_omits_words(make_client):
    result = make_result()
    words = [Word(word=" привет", start=0.0, end=0.5)]
    backend = FakeTranscriptionBackend(result=replace(result, words=words))
    client = await make_client(backend=backend)
    data = {"response_format": "verbose_json", "timestamp_granularities[]": ["segment"]}
    r = await client.post(URL, data=data, files=FILES)
    assert backend.last_options is not None
    assert backend.last_options.word_timestamps is False
    assert "words" not in r.json()


async def test_options_passed(make_client):
    client = await make_client()
    data = {"model": "whisper-1", "language": "ru", "prompt": "p", "temperature": "0.2"}
    r = await client.post(URL, data=data, files=FILES)
    assert r.status_code == 200
    assert client.backend.last_options == TranscriptionOptions("ru", "p", 0.2, False)


async def test_empty_language_and_prompt_become_none(make_client):
    client = await make_client()
    r = await client.post(URL, data={"language": "", "prompt": ""}, files=FILES)
    assert r.status_code == 200
    assert client.backend.last_options == TranscriptionOptions(None, None, 0.0, False)


async def test_unknown_model_404(make_client):
    client = await make_client()
    r = await client.post(URL, data={"model": "nope"}, files=FILES)
    assert r.status_code == 404
    assert _error(r)["code"] == "model_not_found"
    assert _error(r)["param"] == "model"
    assert _error(r)["type"] == "invalid_request_error"


async def test_bad_response_format_400(make_client):
    client = await make_client()
    r = await client.post(URL, data={"response_format": "xml"}, files=FILES)
    assert r.status_code == 400
    assert _error(r)["param"] == "response_format"
    assert _error(r)["code"] == "invalid_request_error"


async def test_bad_granularity_400(make_client):
    client = await make_client()
    r = await client.post(URL, data={"timestamp_granularities[]": ["char"]}, files=FILES)
    assert r.status_code == 400
    assert _error(r)["param"] == "timestamp_granularities[]"


async def test_unknown_language_rejected(make_client):
    client = await make_client()
    r = await client.post(URL, data={"language": "xx"}, files=FILES)
    assert r.status_code == 400
    assert _error(r)["param"] == "language"
    assert _error(r)["type"] == "invalid_request_error"
    assert client.backend.load_calls == 0


async def test_missing_file_400(make_client):
    client = await make_client()
    r = await client.post(URL, data={"model": "whisper-1"})
    assert r.status_code == 400
    assert _error(r)["code"] == "invalid_request_error"
    assert _error(r)["type"] == "invalid_request_error"
    assert _error(r)["param"] == "file"


async def test_bad_temperature_400(make_client):
    client = await make_client()
    r = await client.post(URL, data={"temperature": "hot"}, files=FILES)
    assert r.status_code == 400
    assert _error(r)["param"] == "temperature"


async def test_empty_file_is_invalid_audio(make_client):
    client = await make_client()
    r = await client.post(URL, files={"file": ("a.wav", b"", "audio/wav")})
    assert r.status_code == 400
    assert _error(r)["code"] == "invalid_audio"
    assert client.backend.load_calls == 0


async def test_file_too_large_413(make_client):
    client = await make_client(max_upload_mb=1)
    big = b"x" * (1024 * 1024 + 1)
    r = await client.post(URL, files={"file": ("a.wav", big, "audio/wav")})
    assert r.status_code == 413
    assert _error(r)["code"] == "file_too_large"
    assert client.backend.load_calls == 0


async def test_file_at_limit_ok(make_client):
    client = await make_client(max_upload_mb=1)
    r = await client.post(URL, files={"file": ("a.wav", b"x" * (1024 * 1024), "audio/wav")})
    assert r.status_code == 200


async def test_content_length_precheck_413(make_client):
    client = await make_client()
    r = await client.post(
        URL,
        content=b"x",
        headers={
            "Content-Length": "10000000000",
            "Content-Type": "multipart/form-data; boundary=xyz",
        },
    )
    assert r.status_code == 413
    assert _error(r)["code"] == "file_too_large"
    assert client.backend.load_calls == 0


async def test_invalid_audio_from_backend(make_client):
    backend = FakeTranscriptionBackend(
        transcribe_error=GatewayError(400, "invalid_audio", "не аудио", param="file")
    )
    client = await make_client(backend=backend)
    r = await client.post(URL, files=FILES)
    assert r.status_code == 400
    assert _error(r)["code"] == "invalid_audio"


async def test_load_oom_is_503(make_client):
    backend = FakeTranscriptionBackend(load_error=RuntimeError("out of memory"))
    client = await make_client(backend=backend)
    r = await client.post(URL, files=FILES)
    assert r.status_code == 503
    assert r.headers["Retry-After"] == "30"
    assert _error(r)["code"] == "model_unavailable"
    assert _error(r)["type"] == "server_error"


async def test_oom_during_transcribe_is_503(make_client):
    backend = FakeTranscriptionBackend(
        transcribe_error=RuntimeError("CUDA failed with error out of memory")
    )
    client = await make_client(backend=backend)
    r = await client.post(URL, files=FILES)
    assert r.status_code == 503
    assert r.headers["Retry-After"] == "30"
    assert _error(r)["code"] == "model_unavailable"


async def test_unexpected_error_500(make_client):
    client = await make_client(
        backend=FakeTranscriptionBackend(transcribe_error=ValueError("boom"))
    )
    r = await client.post(URL, files=FILES)
    assert r.status_code == 500
    assert _error(r)["code"] == "internal_error"
    assert _error(r)["type"] == "server_error"
    assert "boom" not in r.text
    assert len(r.headers["X-Request-ID"]) == 32


async def test_temp_file_removed_on_error(make_client):
    client = await make_client(
        backend=FakeTranscriptionBackend(transcribe_error=ValueError("boom"))
    )
    r = await client.post(URL, files=FILES)
    assert r.status_code == 500
    path = client.backend.last_audio_path
    assert path is not None
    assert not path.exists()


async def test_temp_file_removed_on_success(make_client):
    client = await make_client()
    r = await client.post(URL, files={"file": ("speech.mp3", b"ID3....", "audio/mpeg")})
    assert r.status_code == 200
    path = client.backend.last_audio_path
    assert path is not None
    assert path.suffix == ".mp3"
    assert not path.exists()


async def test_temp_file_content_passed_to_backend(make_client):
    seen: list[bytes] = []
    backend = FakeTranscriptionBackend()
    original = backend.transcribe

    def spy(audio_path, options, hooks=None):
        seen.append(audio_path.read_bytes())
        return original(audio_path, options, hooks)

    backend.transcribe = spy  # type: ignore[method-assign]
    client = await make_client(backend=backend)
    r = await client.post(URL, files=FILES)
    assert r.status_code == 200
    assert seen == [b"RIFF...."]


@pytest.mark.parametrize(
    "message",
    [
        "cuBLAS failed with status CUBLAS_STATUS_ALLOC_FAILED",
        "cuDNN failed with status CUDNN_STATUS_ALLOC_FAILED",
    ],
)
async def test_gpu_alloc_failure_during_transcribe_is_503(make_client, message):
    client = await make_client(
        backend=FakeTranscriptionBackend(transcribe_error=RuntimeError(message))
    )
    r = await client.post(URL, files=FILES)
    assert r.status_code == 503
    assert r.headers["Retry-After"] == "30"
    assert _error(r)["code"] == "model_unavailable"


async def test_chunked_upload_stops_at_limit(make_client):
    # без Content-Length (chunked) лимит считается по фактически прочитанным байтам:
    # тело дальше лимита не читается и не пишется на диск
    client = await make_client(max_upload_mb=1)
    chunk = b"x" * 65536
    total_chunks = 20 * 16  # 20 МиБ
    consumed = 0

    async def body() -> AsyncIterator[bytes]:
        nonlocal consumed
        yield (
            b'--xyz\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n'
            b"Content-Type: audio/wav\r\n\r\n"
        )
        for _ in range(total_chunks):
            consumed += len(chunk)
            yield chunk
        yield b"\r\n--xyz--\r\n"

    r = await client.post(
        URL, content=body(), headers={"Content-Type": "multipart/form-data; boundary=xyz"}
    )
    assert r.status_code == 413
    assert _error(r)["code"] == "file_too_large"
    assert consumed <= 3 * 1024 * 1024
    assert client.backend.load_calls == 0


async def test_chat_model_in_transcriptions_400(make_client):
    client = await make_client()
    r = await client.post(URL, data={"model": "qwen3-14b"}, files=FILES)
    assert r.status_code == 400
    assert _error(r)["code"] == "model_not_supported"
    assert _error(r)["param"] == "model"
    assert client.backend.load_calls == 0


async def test_non_transcription_model_rejected_before_load():
    import copy

    import httpx

    from ai_gateway.app import create_app
    from ai_gateway.config import Settings
    from ai_gateway.lifecycle import ModelManager
    from ai_gateway.registry import ModelRegistry
    from tests.conftest import REGISTRY_DATA
    from tests.fakes import FakeLoadableBackend

    registry = ModelRegistry.from_dict(copy.deepcopy(REGISTRY_DATA), default_ttl=600)
    backend = FakeLoadableBackend()
    manager = ModelManager(registry.whisper_specs(), lambda _spec: backend)
    app = create_app(Settings(_env_file=None, device="cpu"), registry=registry, manager=manager)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await client.post(URL, files=FILES)
    assert r.status_code == 400
    assert _error(r)["param"] == "model"
    assert backend.load_calls == 0


async def test_upload_spool_released_before_transcription(make_client, monkeypatch):
    # спул Starlette закрывается сразу после копирования, а не после распознавания:
    # на диске не лежат две копии файла всё время инференса
    from starlette.datastructures import UploadFile

    events: list[str] = []
    original_close = UploadFile.close

    async def close(self):
        events.append("close")
        await original_close(self)

    monkeypatch.setattr(UploadFile, "close", close)
    backend = FakeTranscriptionBackend()
    original = backend.transcribe

    def spy(audio_path, options, hooks=None):
        events.append("transcribe")
        return original(audio_path, options, hooks)

    backend.transcribe = spy  # type: ignore[method-assign]
    client = await make_client(backend=backend)
    r = await client.post(URL, files=FILES)
    assert r.status_code == 200
    assert events.index("close") < events.index("transcribe")


async def test_sync_saved_to_history_source_api(make_client):
    client = await make_client()
    r = await client.post(URL, files=FILES)
    assert r.status_code == 200
    [record] = client.store.records.values()
    assert (record.source, record.status, record.filename) == ("api", "done", "a.wav")
    assert record.params.word_timestamps is False


async def test_sync_disconnect_still_saves(make_client):
    import asyncio
    import threading

    gate = threading.Event()
    client = await make_client(backend=FakeTranscriptionBackend(transcribe_gate=gate))
    request = asyncio.create_task(client.post(URL, files=FILES))
    await asyncio.to_thread(client.backend.transcribe_started.wait, 2)
    request.cancel()  # клиент оборвал соединение
    gate.set()
    async with asyncio.timeout(3):
        while not any(r.status == "done" for r in client.store.records.values()):
            await asyncio.sleep(0.01)
