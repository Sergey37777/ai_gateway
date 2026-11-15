"""`/api/documents…` — документы для чтения, правки и вопросов к модели (этап 6).

Файл читает и декодирует браузер: сюда приходит JSON с текстом; скачивание тоже делает браузер.
"""

import uuid
from pathlib import PurePosixPath
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import AfterValidator, BaseModel, ConfigDict, Field
from starlette.responses import Response

from ai_gateway.api.deps import get_documents, get_settings
from ai_gateway.api.transcriptions import iso
from ai_gateway.config import Settings
from ai_gateway.db.session import decode_position, encode_position
from ai_gateway.documents import (
    DEFAULT_LIMIT,
    MAX_FILENAME,
    MAX_LIMIT,
    MAX_TITLE,
    Document,
    DocumentListItem,
    DocumentListQuery,
    DocumentMeta,
    DocumentStore,
)
from ai_gateway.errors import GatewayError, document_not_found

router = APIRouter()

MIB = 1024 * 1024


def _no_nul(value: str) -> str:
    # PostgreSQL не хранит NUL в text: без проверки запрос упал бы с 500
    if "\x00" in value:
        raise ValueError("строка содержит символ NUL")
    return value


def _filename(value: str) -> str:
    if not value or len(value) > MAX_FILENAME or any(c in value for c in "/\\\x00"):
        raise ValueError(f"имя файла — от 1 до {MAX_FILENAME} символов, без / и \\")
    return value


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CreateIn(_Strict):
    title: str
    filename: Annotated[str, AfterValidator(_filename)]
    format: Literal["markdown", "text"]
    text: Annotated[str, AfterValidator(_no_nul)]


class PatchIn(_Strict):
    title: str


class TextIn(_Strict):
    revision: Annotated[int, Field(ge=0)]
    text: Annotated[str, AfterValidator(_no_nul)]


def _title(value: str) -> str:
    title = value.strip()
    if not title or len(title) > MAX_TITLE or "\x00" in title:
        raise GatewayError(
            400, "invalid_request_error", f"Название — от 1 до {MAX_TITLE} символов", param="title"
        )
    return title


def _check_size(text: str, settings: Settings) -> None:
    if len(text.encode()) > settings.max_document_mb * MIB:
        raise GatewayError(
            413,
            "request_too_large",
            f"Документ больше {settings.max_document_mb} МБ",
            param="text",
        )


def renamed_filename(filename: str, title: str) -> str:
    """Имя файла после переименования: `<название>.<прежнее расширение>`."""
    suffix = PurePosixPath(filename).suffix
    # «/» и «\» в названии допустимы, в имени файла — нет
    base = title.replace("/", "_").replace("\\", "_")
    return f"{base}{suffix}"[:MAX_FILENAME]


def meta_json(meta: DocumentMeta) -> dict[str, object]:
    return {
        "id": str(meta.id),
        "title": meta.title,
        "filename": meta.filename,
        "format": meta.format,
        "chars": meta.chars,
        "revision": meta.revision,
        "question_count": meta.question_count,
        "created_at": iso(meta.created_at),
        "updated_at": iso(meta.updated_at),
    }


def document_json(document: Document) -> dict[str, object]:
    return {**meta_json(document.meta), "text": document.text}


def item_json(item: DocumentListItem, *, search: bool) -> dict[str, object]:
    body = meta_json(item.meta)
    if search:
        body["snippet"] = item.snippet
    return body


def _parse_id(value: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError as exc:
        raise document_not_found() from exc


Store = Annotated[DocumentStore, Depends(get_documents)]
Config = Annotated[Settings, Depends(get_settings)]


@router.post("/documents", status_code=201)
async def create(body: CreateIn, store: Store, settings: Config) -> dict[str, object]:
    title = _title(body.title)
    _check_size(body.text, settings)
    document = await store.create(title, body.filename, body.format, body.text)
    return document_json(document)


@router.get("/documents")
async def list_documents(
    store: Store,
    q: str | None = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    before: str | None = None,
) -> dict[str, object]:
    query = DocumentListQuery(
        q=(q or "").strip() or None,
        limit=limit,
        before=decode_position(before) if before else None,
    )
    page = await store.list(query)
    return {
        "data": [item_json(i, search=query.q is not None) for i in page.items],
        "next": None if page.next is None else encode_position(*page.next),
    }


@router.get("/documents/{did}")
async def get_document(did: str, store: Store) -> dict[str, object]:
    document = await store.get(_parse_id(did))
    if document is None:
        raise document_not_found()
    return document_json(document)


@router.patch("/documents/{did}")
async def rename(did: str, body: PatchIn, store: Store) -> dict[str, object]:
    document_id = _parse_id(did)
    title = _title(body.title)
    current = await store.get(document_id)
    if current is None:
        raise document_not_found()
    meta = await store.rename(document_id, title, renamed_filename(current.meta.filename, title))
    if meta is None:
        raise document_not_found()
    return meta_json(meta)


@router.put("/documents/{did}/text")
async def write_text(did: str, body: TextIn, store: Store, settings: Config) -> dict[str, object]:
    document_id = _parse_id(did)
    _check_size(body.text, settings)
    meta = await store.write_text(document_id, revision=body.revision, text=body.text)
    return {"revision": meta.revision, "updated_at": iso(meta.updated_at), "chars": meta.chars}


@router.delete("/documents/{did}", status_code=204)
async def delete_document(did: str, store: Store) -> Response:
    if not await store.delete(_parse_id(did)):
        raise document_not_found()
    return Response(status_code=204)
