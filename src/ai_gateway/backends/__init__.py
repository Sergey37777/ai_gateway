"""Бэкенды моделей и фабрика по полю `ModelSpec.backend`."""

from collections.abc import Callable

from ai_gateway.backends.base import LoadableBackend
from ai_gateway.registry import ModelSpec

BackendFactory = Callable[[ModelSpec, str, str], LoadableBackend]


def _whisper(spec: ModelSpec, device: str, compute_type: str) -> LoadableBackend:
    # импорт внутри: faster-whisper тянет тяжёлые нативные библиотеки
    from ai_gateway.backends.whisper import WhisperBackend  # type: ignore[import-not-found]

    backend: LoadableBackend = WhisperBackend(
        spec.model, device=device, compute_type=compute_type, vad_filter=spec.vad_filter
    )
    return backend


_FACTORIES: dict[str, BackendFactory] = {"whisper": _whisper}


def build_backend(spec: ModelSpec, *, device: str, compute_type: str) -> LoadableBackend:
    """Создаёт (не загружая веса) бэкенд для модели из реестра."""
    return _FACTORIES[spec.backend](spec, device, compute_type)
