"""GET /ui/config и раздача Web UI."""

from pathlib import Path

import pytest


async def test_ui_config(make_client):
    client = await make_client(max_upload_mb=50)
    r = await client.get("/ui/config")
    assert r.status_code == 200
    body = r.json()
    assert body["max_upload_mb"] == 50
    assert body["auth_required"] is False
    assert body["default_transcription"] == "whisper-large-v3-turbo"
    # порядок REGISTRY_DATA, без алиасов whisper-1 / gpt-4o-mini
    assert body["models"] == [
        {"id": "qwen3-14b", "kind": "chat"},
        {"id": "whisper-large-v3", "kind": "transcription"},
        {"id": "whisper-large-v3-turbo", "kind": "transcription"},
    ]
    assert {"code": "ru", "name": "russian"} in body["languages"]
    assert body["languages"][0] == {"code": "en", "name": "english"}


async def test_ui_config_without_key_when_auth_required(make_client):
    client = await make_client(api_key="secret")
    r = await client.get("/ui/config")
    assert r.status_code == 200
    assert r.json()["auth_required"] is True
    assert "secret" not in r.text


@pytest.fixture
def web_dir(tmp_path: Path) -> Path:
    root = tmp_path / "web"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text("<!doctype html><title>ai_gateway</title>")
    (root / "assets" / "app-abc.js").write_text("console.log(1)")
    (root / "favicon.svg").write_text("<svg/>")
    return root


async def test_index_served_no_cache(make_client, web_dir):
    client = await make_client(web_dir=web_dir)
    r = await client.get("/")
    assert r.status_code == 200
    assert "ai_gateway" in r.text
    assert r.headers["cache-control"] == "no-cache"


async def test_assets_immutable(make_client, web_dir):
    client = await make_client(web_dir=web_dir)
    r = await client.get("/assets/app-abc.js")
    assert r.status_code == 200
    assert "immutable" in r.headers["cache-control"]


async def test_favicon_no_cache(make_client, web_dir):
    client = await make_client(web_dir=web_dir)
    r = await client.get("/favicon.svg")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-cache"


@pytest.mark.parametrize("path", ["/v1/foo", "/nope"])
async def test_unknown_paths_openai_404_with_web(make_client, web_dir, path):
    client = await make_client(web_dir=web_dir)
    r = await client.get(path)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "invalid_request_error"


async def test_api_still_works_with_web(make_client, web_dir):
    client = await make_client(web_dir=web_dir)
    for path in ("/health", "/v1/models", "/ui/config"):
        r = await client.get(path)
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("application/json")


async def test_no_web_dir(make_client):
    client = await make_client()
    r = await client.get("/")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "invalid_request_error"


async def test_web_dir_without_index_not_mounted(make_client, tmp_path):
    empty = tmp_path / "empty-web"
    empty.mkdir()
    (empty / "favicon.svg").write_text("<svg/>")
    client = await make_client(web_dir=empty)
    assert (await client.get("/favicon.svg")).status_code == 404
