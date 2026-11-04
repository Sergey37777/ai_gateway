import copy
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
import yaml

from ai_gateway.errors import GatewayError, model_unavailable
from ai_gateway.registry import ModelRegistry, RegistryError

DATA: dict[str, Any] = {
    "default_transcription": "whisper-large-v3-turbo",
    "aliases": {"whisper-1": "whisper-large-v3-turbo"},
    "models": {
        "whisper-large-v3": {
            "backend": "whisper",
            "model": "large-v3",
            "ttl": 600,
            "max_concurrency": 1,
            "vad_filter": True,
        },
        "whisper-large-v3-turbo": {"backend": "whisper", "model": "large-v3-turbo"},
    },
}

REPO_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def registry() -> ModelRegistry:
    return ModelRegistry.from_dict(copy.deepcopy(DATA), default_ttl=600)


def test_resolve_by_name(registry):
    assert registry.resolve("whisper-large-v3").model == "large-v3"


def test_resolve_alias(registry):
    assert registry.resolve("whisper-1").name == "whisper-large-v3-turbo"


@pytest.mark.parametrize("name", [None, ""])
def test_resolve_default(registry, name):
    assert registry.resolve(name).name == "whisper-large-v3-turbo"
    assert registry.default_transcription == "whisper-large-v3-turbo"


def test_spec_defaults(registry):
    spec = registry.resolve("whisper-large-v3-turbo")
    assert (spec.max_concurrency, spec.vad_filter, spec.backend) == (1, True, "whisper")


def test_default_ttl_applied():
    r = ModelRegistry.from_dict(copy.deepcopy(DATA), default_ttl=42)
    assert r.resolve("whisper-large-v3-turbo").ttl == 42
    assert r.resolve("whisper-large-v3").ttl == 600


def test_unknown_model(registry):
    with pytest.raises(GatewayError) as e:
        registry.resolve("nope")
    assert (e.value.status_code, e.value.code, e.value.param) == (404, "model_not_found", "model")


def test_model_ids(registry):
    assert registry.model_ids() == ["whisper-1", "whisper-large-v3", "whisper-large-v3-turbo"]


def test_specs(registry):
    assert [s.name for s in registry.specs()] == ["whisper-large-v3", "whisper-large-v3-turbo"]


def _alias_to_missing(d):
    d["aliases"]["whisper-1"] = "ghost"


def _default_to_missing(d):
    d["default_transcription"] = "ghost"


def _ttl_minus_2(d):
    d["models"]["whisper-large-v3"]["ttl"] = -2


def _max_concurrency_0(d):
    d["models"]["whisper-large-v3"]["max_concurrency"] = 0


def _unknown_backend(d):
    d["models"]["whisper-large-v3"]["backend"] = "tensorflow"


def _no_models(d):
    d["models"] = {}


@pytest.mark.parametrize(
    ("mutate", "match"),
    [
        (_alias_to_missing, "ghost"),
        (_default_to_missing, "ghost"),
        (_ttl_minus_2, "whisper-large-v3"),
        (_max_concurrency_0, "whisper-large-v3"),
        (_unknown_backend, "whisper-large-v3"),
        (_no_models, "models"),
    ],
)
def test_invalid_config(mutate: Callable[[dict[str, Any]], None], match: str) -> None:
    data = copy.deepcopy(DATA)
    mutate(data)
    with pytest.raises(RegistryError, match=match):
        ModelRegistry.from_dict(data, default_ttl=600)


def test_from_file(tmp_path):
    path = tmp_path / "models.yaml"
    path.write_text(yaml.safe_dump(DATA))
    r = ModelRegistry.from_file(path, default_ttl=600)
    assert r.specs() == ModelRegistry.from_dict(copy.deepcopy(DATA), default_ttl=600).specs()
    assert r.model_ids() == ["whisper-1", "whisper-large-v3", "whisper-large-v3-turbo"]


def test_from_file_not_a_mapping(tmp_path):
    path = tmp_path / "models.yaml"
    path.write_text("- just\n- a list\n")
    with pytest.raises(RegistryError):
        ModelRegistry.from_file(path, default_ttl=600)


def test_repo_model_files_are_valid():
    prod = ModelRegistry.from_file(REPO_ROOT / "models.yaml", default_ttl=600)
    dev = ModelRegistry.from_file(REPO_ROOT / "models.dev.yaml", default_ttl=600)
    assert prod.resolve("whisper-1").name == "whisper-large-v3-turbo"
    assert dev.resolve("whisper-1").name == "whisper-base"


def test_gateway_error_body():
    e = model_unavailable("OOM")
    assert e.status_code == 503
    assert e.headers == {"Retry-After": "30"}
    assert e.to_body() == {
        "error": {
            "message": "OOM",
            "type": "server_error",
            "param": None,
            "code": "model_unavailable",
        }
    }


@pytest.mark.parametrize(
    ("status", "error_type"),
    [(401, "authentication_error"), (400, "invalid_request_error"), (500, "server_error")],
)
def test_gateway_error_type(status, error_type):
    assert GatewayError(status, "c", "m").error_type == error_type
