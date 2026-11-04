from ai_gateway.app import create_app
from ai_gateway.config import Settings
from ai_gateway.lifecycle import ModelStatus

IDS = ["whisper-1", "whisper-large-v3", "whisper-large-v3-turbo"]


async def test_models_list(make_client):
    client = await make_client()
    r = await client.get("/v1/models")
    assert r.status_code == 200
    body = r.json()
    assert body["object"] == "list"
    assert [m["id"] for m in body["data"]] == IDS
    assert body["data"][0] == {
        "id": "whisper-1",
        "object": "model",
        "created": 0,
        "owned_by": "ai_gateway",
    }


async def test_health(make_client):
    client = await make_client()
    r = await client.get("/health")
    assert r.status_code == 200
    assert r.json() == {
        "status": "ok",
        "device": "cpu",
        "models": [
            {"name": "whisper-large-v3", "loaded": False, "active": 0, "idle_seconds": None},
            {"name": "whisper-large-v3-turbo", "loaded": False, "active": 0, "idle_seconds": None},
        ],
    }


async def test_health_after_request_shows_loaded(make_client):
    client = await make_client()
    await client.post(
        "/v1/audio/transcriptions",
        data={"model": "whisper-1"},
        files={"file": ("a.wav", b"RIFF....", "audio/wav")},
    )
    models = {m["name"]: m for m in (await client.get("/health")).json()["models"]}
    assert models["whisper-large-v3-turbo"]["loaded"] is True
    assert models["whisper-large-v3-turbo"]["idle_seconds"] >= 0


async def test_auth_required(make_client):
    client = await make_client(api_key="k")
    r = await client.get("/v1/models")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "invalid_api_key"
    assert r.json()["error"]["type"] == "authentication_error"


async def test_auth_wrong_key(make_client):
    client = await make_client(api_key="k")
    r = await client.get("/v1/models", headers={"Authorization": "Bearer bad"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "invalid_api_key"


async def test_auth_required_on_transcriptions(make_client):
    client = await make_client(api_key="k")
    r = await client.post(
        "/v1/audio/transcriptions", files={"file": ("a.wav", b"RIFF....", "audio/wav")}
    )
    assert r.status_code == 401
    assert client.backend.load_calls == 0


async def test_auth_ok(make_client):
    client = await make_client(api_key="k")
    r = await client.get("/v1/models", headers={"Authorization": "Bearer k"})
    assert r.status_code == 200


async def test_health_without_auth(make_client):
    client = await make_client(api_key="k")
    r = await client.get("/health")
    assert r.status_code == 200


async def test_request_id_generated(make_client):
    client = await make_client()
    r = await client.get("/health")
    assert len(r.headers["X-Request-ID"]) == 32


async def test_request_id_propagated(make_client):
    client = await make_client()
    r = await client.get("/health", headers={"X-Request-ID": "abc"})
    assert r.headers["X-Request-ID"] == "abc"
    r = await client.post(
        "/v1/audio/transcriptions",
        data={"model": "nope"},
        files={"file": ("a.wav", b"RIFF....", "audio/wav")},
        headers={"X-Request-ID": "abc"},
    )
    assert r.status_code == 404
    assert r.headers["X-Request-ID"] == "abc"


async def test_unknown_route_openai_format(make_client):
    client = await make_client()
    r = await client.get("/v1/nothing")
    assert r.status_code == 404
    assert r.json()["error"]["type"] == "invalid_request_error"


async def test_lifespan_builds_from_settings(tmp_path):
    models_file = tmp_path / "m.yaml"
    models_file.write_text(
        "default_transcription: w\nmodels:\n  w:\n    backend: whisper\n    model: tiny\n"
    )
    settings = Settings(_env_file=None, device="cpu", models_file=models_file)
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        assert app.state.device == "cpu"
        assert app.state.manager.status() == [ModelStatus("w", False, 0, None)]
        assert app.state.registry.resolve(None).ttl == 600


def test_logging_hides_local_values(capsys):
    from loguru import logger

    from ai_gateway.app import configure_logging

    configure_logging("INFO")
    secret = "s3cr3t-value"
    try:
        raise ValueError(secret[:1])
    except ValueError:
        logger.exception("сбой")
    err = capsys.readouterr().err
    assert "сбой" in err
    assert "s3cr3t-value" not in err
