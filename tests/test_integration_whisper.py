"""Реальная модель faster-whisper на CPU через официальный OpenAI SDK (`pytest -m integration`).

История — настоящий PostgreSQL (testcontainers, `postgres:17-alpine`).
"""

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import httpx2
import pytest
from fastapi import FastAPI
from openai import AsyncOpenAI
from sqlalchemy.ext.asyncio import AsyncEngine

from ai_gateway.app import create_app
from ai_gateway.config import Settings

pytestmark = pytest.mark.integration

REPO_ROOT = Path(__file__).resolve().parent.parent
HELLO = REPO_ROOT / "tests" / "fixtures" / "hello.wav"


@pytest.fixture
async def app(tmp_path: Path, postgres_url: str, pg_engine: AsyncEngine) -> AsyncIterator[FastAPI]:
    # pg_engine — ради очистки таблиц после теста
    settings = Settings(
        _env_file=None,
        device="cpu",
        models_file=REPO_ROOT / "models.dev.yaml",
        database_url=postgres_url,
        data_dir=tmp_path / "data",
    )
    application = create_app(settings)
    async with application.router.lifespan_context(application):
        yield application


@pytest.fixture
async def http(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", timeout=300
    ) as client:
        yield client


@pytest.fixture
async def openai_client(app: FastAPI) -> AsyncIterator[AsyncOpenAI]:
    # openai 3.x типизирует http_client как httpx2.AsyncClient
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app), base_url="http://test", timeout=300
    ) as http_client:
        yield AsyncOpenAI(base_url="http://test/v1", api_key="x", http_client=http_client)


async def test_openai_sdk_transcription(openai_client):
    with HELLO.open("rb") as f:
        r = await openai_client.audio.transcriptions.create(model="whisper-1", file=f)
    assert "hello" in r.text.lower()


async def test_openai_sdk_verbose_words(openai_client):
    with HELLO.open("rb") as f:
        r = await openai_client.audio.transcriptions.create(
            model="whisper-tiny",
            file=f,
            response_format="verbose_json",
            timestamp_granularities=["word"],
        )
    assert r.language == "english"
    assert r.words
    assert r.duration > 0


async def test_garbage_audio_is_400(http):
    files = {"file": ("a.wav", b"not audio at all" * 100, "audio/wav")}
    r = await http.post("/v1/audio/transcriptions", files=files)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "invalid_audio"


async def test_sdk_call_saved_to_history(openai_client, http):
    with HELLO.open("rb") as f:
        await openai_client.audio.transcriptions.create(model="whisper-tiny", file=f)
    page = (await http.get("/api/transcriptions")).json()
    assert page["data"][0]["source"] == "api"
    assert page["data"][0]["status"] == "done"


async def test_background_job_via_api(http):
    with HELLO.open("rb") as f:
        r = await http.post(
            "/api/transcriptions",
            files={"file": ("hello.wav", f.read(), "audio/wav")},
            data={"model": "whisper-tiny"},
        )
    assert r.status_code == 202
    tid = r.json()["id"]
    async with asyncio.timeout(120):
        while (body := (await http.get(f"/api/transcriptions/{tid}")).json())["status"] in (
            "queued",
            "running",
        ):
            await asyncio.sleep(0.2)
    assert body["status"] == "done", body
    assert body["has_audio"] is True
    verbose = (await http.get(f"/api/transcriptions/{tid}/result")).json()
    assert "hello" in verbose["text"].lower()
    assert verbose["words"]
    audio = await http.get(f"/api/transcriptions/{tid}/audio")
    assert audio.headers["content-type"] == "audio/webm"
    found = (await http.get("/api/transcriptions", params={"q": "hello"})).json()["data"]
    assert [item["id"] for item in found] == [tid]
