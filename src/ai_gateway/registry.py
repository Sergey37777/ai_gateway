"""Реестр моделей: имя или алиас → `WhisperSpec` / `OllamaSpec`, валидация при старте."""

from collections.abc import Mapping
from pathlib import Path
from typing import Annotated, Literal, overload

import yaml
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from ai_gateway.errors import GatewayError


class WhisperSpec(BaseModel):
    """Описание модели распознавания речи (faster-whisper) из реестра."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str
    backend: Literal["whisper"]
    model: str
    ttl: int = Field(ge=-1)
    max_concurrency: int = Field(default=1, ge=1)
    vad_filter: bool = True


class OllamaSpec(BaseModel):
    """Описание чат-модели Ollama; память и TTL ведёт сама Ollama (`keep_alive`)."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str
    backend: Literal["ollama"]
    model: str


ModelSpec = Annotated[WhisperSpec | OllamaSpec, Field(discriminator="backend")]
_SPEC_ADAPTER: TypeAdapter[WhisperSpec | OllamaSpec] = TypeAdapter(ModelSpec)

ModelKind = Literal["transcription", "chat"]


class RegistryError(ValueError):
    """Ошибка конфигурации реестра моделей."""


class ModelRegistry:
    """Неизменяемый реестр моделей и алиасов."""

    def __init__(
        self,
        specs: Mapping[str, WhisperSpec | OllamaSpec],
        aliases: Mapping[str, str],
        default_transcription: str,
    ) -> None:
        self._specs = dict(specs)
        self._aliases = dict(aliases)
        self._default_transcription = default_transcription

    @classmethod
    def from_dict(cls, data: Mapping[str, object], *, default_ttl: int) -> "ModelRegistry":
        """Строит реестр из словаря (содержимое `models.yaml`); ошибки → `RegistryError`."""
        models = data.get("models")
        if not isinstance(models, Mapping) or not models:
            raise RegistryError("В реестре нет моделей: секция 'models' пуста или отсутствует")

        specs: dict[str, WhisperSpec | OllamaSpec] = {}
        for name, raw in models.items():
            if not isinstance(raw, Mapping):
                raise RegistryError(f"Модель {name}: описание должно быть словарём")
            try:
                # TTL по умолчанию относится только к моделям, которые шлюз сам грузит в VRAM
                defaults = {"ttl": default_ttl} if raw.get("backend") == "whisper" else {}
                specs[str(name)] = _SPEC_ADAPTER.validate_python(
                    {**defaults, **raw, "name": str(name)}
                )
            except ValidationError as exc:
                raise RegistryError(f"Модель {name}: некорректная конфигурация: {exc}") from exc

        raw_aliases = data.get("aliases") or {}
        if not isinstance(raw_aliases, Mapping):
            raise RegistryError("Секция 'aliases' должна быть словарём")
        aliases = {str(k): str(v) for k, v in raw_aliases.items()}
        for alias, target in aliases.items():
            if alias in specs:
                raise RegistryError(f"Алиас {alias} совпадает с именем модели")
            if target not in specs:
                raise RegistryError(f"Алиас {alias} ссылается на неизвестную модель {target}")

        default = data.get("default_transcription")
        if not isinstance(default, str) or not default:
            raise RegistryError("Не задана модель по умолчанию 'default_transcription'")
        default = aliases.get(default, default)
        if default not in specs:
            raise RegistryError(f"default_transcription ссылается на неизвестную модель {default}")
        if not isinstance(specs[default], WhisperSpec):
            raise RegistryError(
                f"default_transcription ссылается на модель {default}, которая не распознаёт речь"
            )

        return cls(specs, aliases, default)

    @classmethod
    def from_file(cls, path: Path, *, default_ttl: int) -> "ModelRegistry":
        """Читает реестр из YAML-файла."""
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError) as exc:
            raise RegistryError(f"Не удалось прочитать реестр моделей {path}: {exc}") from exc
        if not isinstance(data, Mapping):
            raise RegistryError(f"Реестр моделей {path} должен быть YAML-словарём")
        return cls.from_dict(data, default_ttl=default_ttl)

    @property
    def default_transcription(self) -> str:
        """Имя модели распознавания по умолчанию."""
        return self._default_transcription

    @overload
    def resolve(self, name: str | None, kind: Literal["transcription"]) -> WhisperSpec: ...

    @overload
    def resolve(self, name: str | None, kind: Literal["chat"]) -> OllamaSpec: ...

    def resolve(self, name: str | None, kind: ModelKind) -> WhisperSpec | OllamaSpec:
        """Имя или алиас → спецификация нужного типа.

        Пустое имя: для распознавания — модель по умолчанию, для чата — 400.
        Неизвестное имя → 404, модель другого типа → 400 `model_not_supported`.
        """
        if not name and kind == "chat":
            raise GatewayError(400, "invalid_request_error", "Не указана модель", param="model")
        key = name or self._default_transcription
        key = self._aliases.get(key, key)
        spec = self._specs.get(key)
        if spec is None:
            raise GatewayError(404, "model_not_found", f"Модель '{name}' не найдена", param="model")
        expected = WhisperSpec if kind == "transcription" else OllamaSpec
        if not isinstance(spec, expected):
            raise GatewayError(
                400,
                "model_not_supported",
                f"Модель '{name}' не поддерживается этим эндпоинтом",
                param="model",
            )
        return spec

    def specs(self) -> list[WhisperSpec | OllamaSpec]:
        """Все модели реестра (без алиасов)."""
        return list(self._specs.values())

    def whisper_specs(self) -> list[WhisperSpec]:
        """Только модели распознавания речи — их держит в VRAM `ModelManager`."""
        return [s for s in self._specs.values() if isinstance(s, WhisperSpec)]

    def model_ids(self) -> list[str]:
        """Имена моделей и алиасов, отсортированные."""
        return sorted([*self._specs, *self._aliases])
