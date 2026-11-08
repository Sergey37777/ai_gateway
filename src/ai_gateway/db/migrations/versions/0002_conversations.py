"""Диалоги чата и их сообщения (этап 5).

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-08
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CONVERSATION_SEARCH = "to_tsvector('russian'::regconfig, title)"
MESSAGE_SEARCH = "to_tsvector('russian'::regconfig, text)"
MESSAGE_ROLE_FIELDS = (
    "(role = 'user' AND status IS NULL AND reasoning IS NULL AND error IS NULL "
    "AND usage IS NULL AND model IS NULL) "
    "OR (role = 'assistant' AND status IS NOT NULL AND images IS NULL)"
)


def upgrade() -> None:
    op.create_table(
        "conversations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("settings", postgresql.JSONB(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "search",
            postgresql.TSVECTOR(),
            sa.Computed(CONVERSATION_SEARCH, persisted=True),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_conversations_updated",
        "conversations",
        [sa.text("updated_at DESC"), sa.text("id DESC")],
    )
    op.create_index("ix_conversations_search", "conversations", ["search"], postgresql_using="gin")
    op.create_table(
        "conversation_messages",
        sa.Column(
            "conversation_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("conversations.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("position", sa.Integer(), primary_key=True),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("images", postgresql.JSONB()),
        sa.Column("reasoning", sa.Text()),
        sa.Column("status", sa.Text()),
        sa.Column("error", sa.Text()),
        sa.Column("usage", postgresql.JSONB()),
        sa.Column("model", sa.Text()),
        sa.Column(
            "search",
            postgresql.TSVECTOR(),
            sa.Computed(MESSAGE_SEARCH, persisted=True),
            nullable=False,
        ),
        sa.CheckConstraint("role IN ('user', 'assistant')", name="ck_conversation_messages_role"),
        sa.CheckConstraint(
            "status IN ('done', 'stopped', 'error')", name="ck_conversation_messages_status"
        ),
        sa.CheckConstraint(MESSAGE_ROLE_FIELDS, name="ck_conversation_messages_role_fields"),
    )
    op.create_index(
        "ix_conversation_messages_search",
        "conversation_messages",
        ["search"],
        postgresql_using="gin",
    )


def downgrade() -> None:
    op.drop_table("conversation_messages")
    op.drop_table("conversations")
