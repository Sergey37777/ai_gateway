"""GET /ui/config и раздача Web UI."""


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
