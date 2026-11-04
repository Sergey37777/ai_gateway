"""Реестр моделей: имя или алиас → `ModelSpec`, валидация `models.yaml` при старте."""

from collections.abc import Mapping
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ai_gateway.errors import GatewayError


class ModelSpec(BaseModel):
    """Описание модели из реестра."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str
    backend: Literal["whisper"]
    model: str
    ttl: int = Field(ge=-1)
    max_concurrency: int = Field(default=1, ge=1)
    vad_filter: bool = True


class RegistryError(ValueError):
    """Ошибка конфигурации реестра моделей."""


class ModelRegistry:
    """Неизменяемый реестр моделей и алиасов."""

    def __init__(
        self,
        specs: Mapping[str, ModelSpec],
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

        specs: dict[str, ModelSpec] = {}
        for name, raw in models.items():
            if not isinstance(raw, Mapping):
                raise RegistryError(f"Модель {name}: описание должно быть словарём")
            try:
                specs[str(name)] = ModelSpec.model_validate(
                    {"ttl": default_ttl, **raw, "name": str(name)}
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

    def resolve(self, name: str | None) -> ModelSpec:
        """Имя или алиас → спецификация; пустое имя → модель по умолчанию; иначе 404."""
        key = name or self._default_transcription
        key = self._aliases.get(key, key)
        spec = self._specs.get(key)
        if spec is None:
            raise GatewayError(404, "model_not_found", f"Модель '{name}' не найдена", param="model")
        return spec

    def specs(self) -> list[ModelSpec]:
        """Все модели реестра (без алиасов)."""
        return list(self._specs.values())

    def model_ids(self) -> list[str]:
        """Имена моделей и алиасов, отсортированные."""
        return sorted([*self._specs, *self._aliases])
