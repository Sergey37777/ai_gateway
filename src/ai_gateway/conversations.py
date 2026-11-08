"""Диалоги чата (этап 5): записи, протокол хранилища и реализация на SQLAlchemy (PostgreSQL).

Генерация ответов идёт мимо этого модуля (`/v1/chat/completions` из браузера); UI сохраняет
готовые сообщения операцией «замена хвоста» (`replace_tail`) с проверкой `revision`.
ORM-строки наружу не выходят — только frozen dataclass'ы.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

ReasoningEffort = Literal["none", "low", "medium", "high"]
AnswerStatus = Literal["done", "stopped", "error"]

MAX_TITLE = 200
DEFAULT_LIMIT = 30
MAX_LIMIT = 100


@dataclass(frozen=True, slots=True)
class ChatSettings:
    """Настройки диалога; `model` по реестру не проверяется — модель могли убрать."""

    model: str
    system_prompt: str
    temperature: float | None
    max_tokens: int | None
    reasoning_effort: ReasoningEffort | None


@dataclass(frozen=True, slots=True)
class ImagePart:
    name: str
    data_url: str


@dataclass(frozen=True, slots=True)
class Usage:
    prompt_tokens: int
    completion_tokens: int


@dataclass(frozen=True, slots=True)
class UserMessage:
    text: str
    images: tuple[ImagePart, ...]


@dataclass(frozen=True, slots=True)
class AssistantMessage:
    text: str
    reasoning: str
    status: AnswerStatus
    error: str | None
    usage: Usage | None
    model: str | None


Message = UserMessage | AssistantMessage


@dataclass(frozen=True, slots=True)
class ConversationMeta:
    id: uuid.UUID
    title: str
    settings: ChatSettings
    revision: int
    message_count: int
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class Conversation:
    meta: ConversationMeta
    messages: tuple[Message, ...]


@dataclass(frozen=True, slots=True)
class ListQuery:
    q: str | None = None
    limit: int = DEFAULT_LIMIT
    # курсор: диалоги строго «старше» (`updated_at`, `id`)
    before: tuple[datetime, uuid.UUID] | None = None


@dataclass(frozen=True, slots=True)
class ListItem:
    meta: ConversationMeta
    snippet: str | None = None


@dataclass(frozen=True, slots=True)
class Page:
    items: list[ListItem]
    next: tuple[datetime, uuid.UUID] | None
