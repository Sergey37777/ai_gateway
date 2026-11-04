"""Конфигурация шлюза: переменные окружения с префиксом AIGW_ и выбор устройства."""

from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

Device = Literal["cuda", "cpu"]


class Settings(BaseSettings):
    """Настройки сервиса; читаются из окружения (`AIGW_*`) и файла `.env`."""

    model_config = SettingsConfigDict(env_prefix="AIGW_", env_file=".env", extra="ignore")

    device: Literal["auto", "cuda", "cpu"] = "auto"
    compute_type: str = "auto"
    api_key: str | None = None
    max_upload_mb: int = 200
    models_file: Path = Path("models.yaml")
    default_ttl: int = 600
    sweep_interval: float = 30.0
    ollama_url: str = "http://localhost:11434"
    ollama_read_timeout: float = 300.0
    web_dir: Path = Path("web/dist")
    log_level: str = "INFO"


def resolve_device(device: str, cuda_device_count: int) -> Device:
    """`auto` → `cuda`, если видна хотя бы одна CUDA-карта, иначе `cpu`."""
    if device == "auto":
        return "cuda" if cuda_device_count > 0 else "cpu"
    if device == "cuda":
        return "cuda"
    return "cpu"


def resolve_compute_type(compute_type: str, device: str) -> str:
    """`auto` → `float16` на GPU и `int8` на CPU; явное значение не меняется."""
    if compute_type != "auto":
        return compute_type
    return "float16" if device == "cuda" else "int8"


def detect_cuda_device_count() -> int:
    """Количество CUDA-устройств по данным CTranslate2 (0, если он недоступен)."""
    try:
        import ctranslate2
    except ImportError:
        return 0
    count: int = ctranslate2.get_cuda_device_count()
    return count
