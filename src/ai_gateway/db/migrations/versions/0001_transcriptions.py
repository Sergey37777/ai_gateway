"""Распознавания и их результаты (этап 4).

Revision ID: 0001
Revises:
Create Date: 2026-11-04
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SEARCH = "to_tsvector('russian'::regconfig, title || ' ' || coalesce(text, ''))"


def upgrade() -> None:
    op.create_table(
        "transcriptions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("filename", sa.Text(), nullable=False),
        sa.Column("model", sa.Text(), nullable=False),
        sa.Column("options", postgresql.JSONB(), nullable=False),
        sa.Column("upload_path", sa.Text()),
        sa.Column("audio_path", sa.Text()),
        sa.Column("audio_bytes", sa.BigInteger()),
        sa.Column("language", sa.Text()),
        sa.Column("duration", sa.Float()),
        sa.Column("text", sa.Text()),
        sa.Column("error_code", sa.Text()),
        sa.Column("error_message", sa.Text()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
        sa.Column(
            "search",
            postgresql.TSVECTOR(),
            sa.Computed(SEARCH, persisted=True),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('queued', 'running', 'done', 'failed', 'cancelled')",
            name="ck_transcriptions_status",
        ),
        sa.CheckConstraint("source IN ('ui', 'api')", name="ck_transcriptions_source"),
    )
    op.create_index(
        "ix_transcriptions_created",
        "transcriptions",
        [sa.text("created_at DESC"), sa.text("id DESC")],
    )
    op.create_index(
        "ix_transcriptions_search", "transcriptions", ["search"], postgresql_using="gin"
    )
    op.create_index(
        "ix_transcriptions_queued",
        "transcriptions",
        ["created_at"],
        postgresql_where=sa.text("status = 'queued'"),
    )
    op.create_table(
        "transcription_results",
        sa.Column(
            "transcription_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("transcriptions.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("segments", postgresql.JSONB(), nullable=False),
        sa.Column("words", postgresql.JSONB()),
    )


def downgrade() -> None:
    op.drop_table("transcription_results")
    op.drop_table("transcriptions")
