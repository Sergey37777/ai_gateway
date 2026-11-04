import os
from pathlib import Path

import pytest

from ai_gateway.config import Settings, resolve_compute_type, resolve_device


@pytest.fixture(autouse=True)
def clean_env(monkeypatch, tmp_path):
    # изолируемся от .env в корне проекта и от AIGW_* в окружении
    monkeypatch.chdir(tmp_path)
    for key in list(os.environ):
        if key.startswith("AIGW_"):
            monkeypatch.delenv(key)


def test_defaults():
    s = Settings()
    assert (s.device, s.compute_type, s.api_key) == ("auto", "auto", None)
    assert (s.max_upload_mb, s.default_ttl, s.sweep_interval) == (200, 600, 30.0)
    assert s.models_file == Path("models.yaml")
    assert s.log_level == "INFO"
    assert (s.ollama_url, s.ollama_read_timeout) == ("http://localhost:11434", 300.0)


def test_env_prefix(monkeypatch):
    monkeypatch.setenv("AIGW_MAX_UPLOAD_MB", "5")
    monkeypatch.setenv("AIGW_API_KEY", "secret")
    s = Settings()
    assert s.max_upload_mb == 5
    assert s.api_key == "secret"


def test_env_file(tmp_path):
    (tmp_path / ".env").write_text("AIGW_DEVICE=cpu\n")
    assert Settings().device == "cpu"


@pytest.mark.parametrize(
    ("device", "count", "expected"),
    [("auto", 1, "cuda"), ("auto", 0, "cpu"), ("cpu", 1, "cpu"), ("cuda", 0, "cuda")],
)
def test_resolve_device(device, count, expected):
    assert resolve_device(device, count) == expected


@pytest.mark.parametrize(
    ("ct", "device", "expected"),
    [
        ("auto", "cuda", "float16"),
        ("auto", "cpu", "int8"),
        ("int8_float16", "cuda", "int8_float16"),
    ],
)
def test_resolve_compute_type(ct, device, expected):
    assert resolve_compute_type(ct, device) == expected


def test_database_defaults():
    settings = Settings(_env_file=None)
    assert settings.database_url == "postgresql+psycopg://aigw:aigw@localhost:55432/aigw"
    assert settings.data_dir == Path("data")
