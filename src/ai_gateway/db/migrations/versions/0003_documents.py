"""Документы и привязка диалогов к ним (этап 6).

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# у tsvector предел 1 МБ: в поиск идёт начало текста (документ до AIGW_MAX_DOCUMENT_MB)
DOCUMENT_SEARCH = (
    "setweight(to_tsvector('russian'::regconfig, title), 'A') || "
    "to_tsvector('russian'::regconfig, left(text, 1000000))"
)
CONVERSATION_DOCUMENT = (
    "(document_id IS NULL AND quote IS NULL AND context IS NULL) "
    "OR (document_id IS NOT NULL AND quote IS NOT NULL AND context IS NOT NULL)"
)


def upgrade() -> None:
    op.create_table(
        "documents",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("filename", sa.Text(), nullable=False),
        sa.Column("format", sa.Text(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("chars", sa.Integer(), nullable=False),
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
            sa.Computed(DOCUMENT_SEARCH, persisted=True),
            nullable=False,
        ),
        sa.CheckConstraint("format IN ('markdown', 'text')", name="ck_documents_format"),
    )
    op.create_index(
        "ix_documents_updated", "documents", [sa.text("updated_at DESC"), sa.text("id DESC")]
    )
    op.create_index("ix_documents_search", "documents", ["search"], postgresql_using="gin")
    op.add_column(
        "conversations",
        sa.Column(
            "document_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("documents.id", ondelete="CASCADE", name="fk_conversations_document"),
        ),
    )
    op.add_column("conversations", sa.Column("quote", sa.Text()))
    op.add_column("conversations", sa.Column("context", sa.Text()))
    op.create_check_constraint("ck_conversations_document", "conversations", CONVERSATION_DOCUMENT)
    op.create_index(
        "ix_conversations_document",
        "conversations",
        ["document_id", sa.text("updated_at DESC"), sa.text("id DESC")],
    )


def downgrade() -> None:
    # вопросы к документам без документов не имеют смысла
    op.execute("DELETE FROM conversations WHERE document_id IS NOT NULL")
    op.drop_index("ix_conversations_document", table_name="conversations")
    op.drop_constraint("ck_conversations_document", "conversations", type_="check")
    op.drop_column("conversations", "context")
    op.drop_column("conversations", "quote")
    op.drop_column("conversations", "document_id")
    op.drop_table("documents")
