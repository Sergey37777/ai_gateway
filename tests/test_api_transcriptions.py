"""API истории распознаваний `/api/transcriptions…` (фейковые хранилище и бэкенд)."""

import asyncio
import threading
import uuid
from dataclasses import replace

from ai_gateway.backends.base import Word
from tests.fakes import FakeTranscriptionBackend, make_result

URL = "/api/transcriptions"
FILES = {"file": ("meeting.wav", b"RIFF....", "audio/wav")}


async def wait_status(client, tid, status, timeout=3.0):
    async with asyncio.timeout(timeout):
        while True:
            body = (await client.get(f"{URL}/{tid}")).json()
            if body.get("status") == status:
                return body
            await asyncio.sleep(0.01)


async def create(client, **data):
    r = await client.post(URL, files=FILES, data=data)
    assert r.status_code == 202, r.text
    return r.json()


async def test_create_returns_202_queued(make_client):
    client = await make_client()
    body = await create(client, language="ru")
    assert body["status"] in ("queued", "running", "done")
    assert body["title"] == "meeting.wav"
    assert body["filename"] == "meeting.wav"
    assert body["source"] == "ui"
    assert body["model"] == "whisper-large-v3-turbo"
    assert body["error"] is None
    assert body["created_at"].endswith("Z")
    record = client.store.records[uuid.UUID(body["id"])]
    assert record.params.word_timestamps is True
    assert record.params.language == "ru"


async def test_create_with_title_and_validation(make_client):
    client = await make_client()
    body = await create(client, title="Совещание")
    assert body["title"] == "Совещание"
    r = await client.post(URL, files=FILES, data={"language": "xx"})
    assert r.status_code == 400
    assert r.json()["error"]["param"] == "language"
    r = await client.post(URL, files=FILES, data={"model": "qwen3-14b"})
    assert r.status_code == 400


async def test_get_progress_and_done(make_client):
    gate = threading.Event()
    client = await make_client(
        backend=FakeTranscriptionBackend(transcribe_gate=gate, progress_steps=[0.4])
    )
    body = await create(client)
    await asyncio.to_thread(client.backend.transcribe_started.wait, 2)
    running = await wait_status(client, body["id"], "running")
    assert running["progress"] == 0.4
    assert running["queue_position"] is None
    gate.set()
    done = await wait_status(client, body["id"], "done")
    assert done["progress"] == 1.0
    assert done["has_audio"] is True
    assert done["language"] == "ru"
    assert done["duration"] == 1.0
    assert done["finished_at"].endswith("Z")


async def test_queue_position(make_client):
    gate = threading.Event()
    client = await make_client(backend=FakeTranscriptionBackend(transcribe_gate=gate))
    first = await create(client)
    await asyncio.to_thread(client.backend.transcribe_started.wait, 2)
    second = await create(client)
    body = (await client.get(f"{URL}/{second['id']}")).json()
    assert (body["status"], body["queue_position"], body["progress"]) == ("queued", 1, 0.0)
    gate.set()
    await wait_status(client, first["id"], "done")


async def test_list_and_cursor(make_client):
    client = await make_client()
    ids = [(await create(client, title=f"r{i}"))["id"] for i in range(3)]
    r = await client.get(URL, params={"limit": 2})
    assert r.status_code == 200
    page = r.json()
    assert [item["id"] for item in page["data"]] == [ids[2], ids[1]]
    assert page["next"] is not None
    rest = (await client.get(URL, params={"limit": 2, "before": page["next"]})).json()
    assert [item["id"] for item in rest["data"]] == [ids[0]]
    assert rest["next"] is None


async def test_list_q_and_status_filters(make_client):
    client = await make_client()
    await create(client, title="Совещание")
    other = await create(client, title="Лекция")
    await wait_status(client, other["id"], "done")
    found = (await client.get(URL, params={"q": "совещ"})).json()["data"]
    assert [item["title"] for item in found] == ["Совещание"]
    r = await client.get(URL, params={"status": "bogus"})
    assert r.status_code == 400
    assert r.json()["error"]["param"] == "status"
    assert (await client.get(URL, params={"limit": 0})).status_code == 400
    assert (await client.get(URL, params={"limit": 101})).status_code == 400
    assert (await client.get(URL, params={"before": "мусор"})).status_code == 400


async def test_result_formats(make_client):
    words = [Word(word=" привет", start=0.0, end=0.5)]
    client = await make_client(
        backend=FakeTranscriptionBackend(result=replace(make_result(), words=words))
    )
    body = await create(client)
    await wait_status(client, body["id"], "done")
    verbose = (await client.get(f"{URL}/{body['id']}/result")).json()
    assert verbose["words"] == [{"word": " привет", "start": 0.0, "end": 0.5}]
    assert verbose["language"] == "russian"
    srt = await client.get(f"{URL}/{body['id']}/result", params={"format": "srt"})
    assert srt.text.startswith("1\n00:00:00,000 --> 00:00:01,000")
    text = await client.get(f"{URL}/{body['id']}/result", params={"format": "text"})
    assert text.text == "привет мир"
    bad = await client.get(f"{URL}/{body['id']}/result", params={"format": "docx"})
    assert bad.status_code == 400


async def test_result_not_ready_409(make_client):
    gate = threading.Event()
    client = await make_client(backend=FakeTranscriptionBackend(transcribe_gate=gate))
    body = await create(client)
    r = await client.get(f"{URL}/{body['id']}/result")
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "transcription_not_ready"
    gate.set()
    await wait_status(client, body["id"], "done")


async def test_audio_file_response(make_client):
    client = await make_client()
    body = await create(client)
    done = await wait_status(client, body["id"], "done")
    record = client.store.records[uuid.UUID(done["id"])]
    assert record.audio_path is not None
    # настоящий Opus в тестах не нужен: подменяем содержимое файла
    (client.app.state.service.files.resolve(record.audio_path)).write_bytes(bytes(range(64)))
    full = await client.get(f"{URL}/{body['id']}/audio")
    assert full.status_code == 200
    assert full.headers["content-type"] == "audio/webm"
    part = await client.get(f"{URL}/{body['id']}/audio", headers={"Range": "bytes=0-9"})
    assert part.status_code == 206
    assert part.content == bytes(range(10))


async def test_audio_missing_404(make_client):
    gate = threading.Event()
    client = await make_client(backend=FakeTranscriptionBackend(transcribe_gate=gate))
    body = await create(client)
    r = await client.get(f"{URL}/{body['id']}/audio")
    assert r.status_code == 404
    gate.set()
    await wait_status(client, body["id"], "done")


async def test_patch_title(make_client):
    client = await make_client()
    body = await create(client)
    r = await client.patch(f"{URL}/{body['id']}", json={"title": "  Новое  "})
    assert r.status_code == 200
    assert r.json()["title"] == "Новое"
    for title in ["", "   ", "я" * 201]:
        r = await client.patch(f"{URL}/{body['id']}", json={"title": title})
        assert r.status_code == 400
        assert r.json()["error"]["param"] == "title"


async def test_cancel_and_409_when_done(make_client):
    gate = threading.Event()
    client = await make_client(backend=FakeTranscriptionBackend(transcribe_gate=gate))
    first = await create(client)
    await asyncio.to_thread(client.backend.transcribe_started.wait, 2)
    queued = await create(client)
    r = await client.post(f"{URL}/{queued['id']}/cancel")
    assert r.status_code == 200
    assert r.json()["status"] == "cancelled"
    assert r.json()["retryable"] is True
    gate.set()
    await wait_status(client, first["id"], "done")
    r = await client.post(f"{URL}/{first['id']}/cancel")
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "invalid_state"


async def test_retry(make_client):
    backend = FakeTranscriptionBackend(transcribe_error=RuntimeError("out of memory"))
    client = await make_client(backend=backend)
    body = await create(client)
    failed = await wait_status(client, body["id"], "failed")
    assert failed["error"] == {
        "code": "model_unavailable",
        "message": failed["error"]["message"],
    }
    assert failed["retryable"] is True
    backend.transcribe_error = None
    r = await client.post(f"{URL}/{body['id']}/retry")
    assert r.status_code == 200
    assert r.json()["status"] in ("queued", "running")
    await wait_status(client, body["id"], "done")
    r = await client.post(f"{URL}/{body['id']}/retry")
    assert r.status_code == 409


async def test_delete_running(make_client):
    gate = threading.Event()
    client = await make_client(backend=FakeTranscriptionBackend(transcribe_gate=gate))
    body = await create(client)
    await asyncio.to_thread(client.backend.transcribe_started.wait, 2)
    r = await client.delete(f"{URL}/{body['id']}")
    assert r.status_code == 204
    assert (await client.get(f"{URL}/{body['id']}")).status_code == 404
    data_dir = client.app.state.service.files.root
    assert list((data_dir / "uploads").iterdir()) == []


async def test_unknown_id_404(make_client):
    client = await make_client()
    for path in [f"{URL}/{uuid.uuid4()}", f"{URL}/not-a-uuid", f"{URL}/not-a-uuid/result"]:
        r = await client.get(path)
        assert r.status_code == 404
        assert r.json()["error"]["code"] == "transcription_not_found"
    assert (await client.delete(f"{URL}/{uuid.uuid4()}")).status_code == 404


async def test_upload_too_large_413(make_client):
    client = await make_client(max_upload_mb=1)
    r = await client.post(URL, files={"file": ("big.wav", b"x" * (1024 * 1024 + 10), "audio/wav")})
    assert r.status_code == 413
    assert client.store.records == {}
