"""ORM-модели истории распознаваний и диалогов; наружу (за пределы хранилищ) строки не выходят."""

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Computed,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# явный regconfig: генерируемому столбцу нужна IMMUTABLE-версия to_tsvector
SEARCH_EXPRESSION = "to_tsvector('russian'::regconfig, title || ' ' || coalesce(text, ''))"


class Base(DeclarativeBase):
    pass


class TranscriptionRow(Base):
    """Распознавание: задача в очереди и запись истории — одна сущность."""

    __tablename__ = "transcriptions"
    __table_args__ = (
        CheckConstraint(
            "status IN ('queued', 'running', 'done', 'failed', 'cancelled')",
            name="ck_transcriptions_status",
        ),
        CheckConstraint("source IN ('ui', 'api')", name="ck_transcriptions_source"),
        Index("ix_transcriptions_created", "created_at", "id"),
        Index("ix_transcriptions_search", "search", postgresql_using="gin"),
        Index(
            "ix_transcriptions_queued",
            "created_at",
            postgresql_where="status = 'queued'",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    status: Mapped[str] = mapped_column(Text)
    source: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text)
    filename: Mapped[str] = mapped_column(Text)
    model: Mapped[str] = mapped_column(Text)
    # {language, prompt, temperature, word_timestamps}
    options: Mapped[dict[str, object]] = mapped_column(JSONB)
    upload_path: Mapped[str | None] = mapped_column(Text)
    audio_path: Mapped[str | None] = mapped_column(Text)
    audio_bytes: Mapped[int | None] = mapped_column(BigInteger)
    language: Mapped[str | None] = mapped_column(Text)
    duration: Mapped[float | None] = mapped_column(Float)
    text: Mapped[str | None] = mapped_column(Text)
    error_code: Mapped[str | None] = mapped_column(Text)
    error_message: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    search: Mapped[str] = mapped_column(TSVECTOR, Computed(SEARCH_EXPRESSION, persisted=True))


class TranscriptionResultRow(Base):
    """Сегменты и слова (JSONB): читаются только при открытии записи."""

    __tablename__ = "transcription_results"

    transcription_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("transcriptions.id", ondelete="CASCADE"),
        primary_key=True,
    )
    segments: Mapped[list[dict[str, object]]] = mapped_column(JSONB)
    words: Mapped[list[dict[str, object]] | None] = mapped_column(JSONB)


CONVERSATION_SEARCH = "to_tsvector('russian'::regconfig, title)"
MESSAGE_SEARCH = "to_tsvector('russian'::regconfig, text)"
# поля ответа — только у assistant, картинки — только у user
MESSAGE_ROLE_FIELDS = (
    "(role = 'user' AND status IS NULL AND reasoning IS NULL AND error IS NULL "
    "AND usage IS NULL AND model IS NULL) "
    "OR (role = 'assistant' AND status IS NOT NULL AND images IS NULL)"
)


class ConversationRow(Base):
    """Диалог чата (этап 5); сообщения — `ConversationMessageRow`."""

    __tablename__ = "conversations"
    __table_args__ = (
        Index("ix_conversations_updated", "updated_at", "id"),
        Index("ix_conversations_search", "search", postgresql_using="gin"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    title: Mapped[str] = mapped_column(Text)
    # {model, system_prompt, temperature, max_tokens, reasoning_effort}
    settings: Mapped[dict[str, object]] = mapped_column(JSONB)
    revision: Mapped[int] = mapped_column(Integer, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    search: Mapped[str] = mapped_column(TSVECTOR, Computed(CONVERSATION_SEARCH, persisted=True))


class ConversationMessageRow(Base):
    """Сообщение диалога; позиции плотные: 0, 1, 2…"""

    __tablename__ = "conversation_messages"
    __table_args__ = (
        CheckConstraint("role IN ('user', 'assistant')", name="ck_conversation_messages_role"),
        CheckConstraint(
            "status IN ('done', 'stopped', 'error')", name="ck_conversation_messages_status"
        ),
        CheckConstraint(MESSAGE_ROLE_FIELDS, name="ck_conversation_messages_role_fields"),
        Index("ix_conversation_messages_search", "search", postgresql_using="gin"),
    )

    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("conversations.id", ondelete="CASCADE"),
        primary_key=True,
    )
    position: Mapped[int] = mapped_column(Integer, primary_key=True)
    role: Mapped[str] = mapped_column(Text)
    text: Mapped[str] = mapped_column(Text)
    # [{name, data_url}]
    images: Mapped[list[dict[str, object]] | None] = mapped_column(JSONB)
    reasoning: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    # {prompt_tokens, completion_tokens}
    usage: Mapped[dict[str, object] | None] = mapped_column(JSONB)
    model: Mapped[str | None] = mapped_column(Text)
    search: Mapped[str] = mapped_column(TSVECTOR, Computed(MESSAGE_SEARCH, persisted=True))
