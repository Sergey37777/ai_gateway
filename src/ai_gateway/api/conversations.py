"""`/api/conversations…` — диалоги чата, которые сохраняет Web UI (собственный API шлюза)."""

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Body, Depends, Query
from pydantic import AfterValidator, BaseModel, ConfigDict, Field
from starlette.responses import Response

from ai_gateway.api.deps import get_conversations
from ai_gateway.api.transcriptions import iso
from ai_gateway.conversations import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    MAX_TITLE,
    AssistantMessage,
    ChatSettings,
    Conversation,
    ConversationMeta,
    ConversationStore,
    ImagePart,
    ListItem,
    ListQuery,
    Message,
    Usage,
    UserMessage,
    settings_json,
)
from ai_gateway.db.session import decode_position, encode_position
from ai_gateway.errors import GatewayError, conversation_not_found

router = APIRouter()


def _no_nul(value: str) -> str:
    # PostgreSQL не хранит NUL ни в text, ни в jsonb: без проверки запрос упал бы с 500
    if "\x00" in value:
        raise ValueError("строка содержит символ NUL")
    return value


def _image_url(value: str) -> str:
    if not value.startswith("data:image/") or ";base64," not in value:
        raise ValueError("картинка — только base64 data URL (data:image/…;base64,…)")
    return value


Text = Annotated[str, AfterValidator(_no_nul)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SettingsIn(_Strict):
    model: Annotated[Text, Field(min_length=1)]
    system_prompt: Text = ""
    temperature: Annotated[float, Field(ge=0, le=2)] | None = None
    max_tokens: Annotated[int, Field(ge=1)] | None = None
    reasoning_effort: Literal["none", "low", "medium", "high"] | None = None

    def to_settings(self) -> ChatSettings:
        return ChatSettings(
            model=self.model,
            system_prompt=self.system_prompt,
            temperature=self.temperature,
            max_tokens=self.max_tokens,
            reasoning_effort=self.reasoning_effort,
        )


class ImageIn(_Strict):
    name: Text = ""
    data_url: Annotated[str, AfterValidator(_no_nul), AfterValidator(_image_url)]


class UsageIn(_Strict):
    prompt_tokens: Annotated[int, Field(ge=0)]
    completion_tokens: Annotated[int, Field(ge=0)]


class UserMessageIn(_Strict):
    role: Literal["user"]
    text: Text
    images: list[ImageIn] = []


class AssistantMessageIn(_Strict):
    role: Literal["assistant"]
    text: Text
    reasoning: Text = ""
    status: Literal["done", "stopped", "error"]
    error: Text | None = None
    usage: UsageIn | None = None
    model: Text | None = None


MessageIn = Annotated[UserMessageIn | AssistantMessageIn, Field(discriminator="role")]


class CreateIn(_Strict):
    title: str
    settings: SettingsIn
    messages: list[MessageIn]


class PatchIn(_Strict):
    title: str | None = None
    settings: SettingsIn | None = None


class TailIn(_Strict):
    revision: Annotated[int, Field(ge=0)]
    messages: list[MessageIn]


def _title(value: str) -> str:
    title = value.strip()
    if not title or len(title) > MAX_TITLE or "\x00" in title:
        raise GatewayError(
            400,
            "invalid_request_error",
            f"Название — от 1 до {MAX_TITLE} символов",
            param="title",
        )
    return title


def _message(item: UserMessageIn | AssistantMessageIn) -> Message:
    if isinstance(item, UserMessageIn):
        images = tuple(ImagePart(name=i.name, data_url=i.data_url) for i in item.images)
        return UserMessage(text=item.text, images=images)
    if item.status == "error" and not item.error:
        raise GatewayError(
            400, "invalid_request_error", "У ответа с ошибкой нужен текст ошибки", param="error"
        )
    return AssistantMessage(
        text=item.text,
        reasoning=item.reasoning,
        status=item.status,
        error=item.error,
        usage=None
        if item.usage is None
        else Usage(
            prompt_tokens=item.usage.prompt_tokens,
            completion_tokens=item.usage.completion_tokens,
        ),
        model=item.model,
    )


def message_json(message: Message) -> dict[str, object]:
    if isinstance(message, UserMessage):
        return {
            "role": "user",
            "text": message.text,
            "images": [{"name": i.name, "data_url": i.data_url} for i in message.images],
        }
    usage = message.usage
    return {
        "role": "assistant",
        "text": message.text,
        "reasoning": message.reasoning,
        "status": message.status,
        "error": message.error,
        "usage": None
        if usage is None
        else {"prompt_tokens": usage.prompt_tokens, "completion_tokens": usage.completion_tokens},
        "model": message.model,
    }


def meta_json(meta: ConversationMeta) -> dict[str, object]:
    return {
        "id": str(meta.id),
        "title": meta.title,
        "settings": settings_json(meta.settings),
        "revision": meta.revision,
        "message_count": meta.message_count,
        "created_at": iso(meta.created_at),
        "updated_at": iso(meta.updated_at),
    }


def conversation_json(conversation: Conversation) -> dict[str, object]:
    return {
        **meta_json(conversation.meta),
        "messages": [message_json(m) for m in conversation.messages],
    }


def item_json(item: ListItem, *, search: bool) -> dict[str, object]:
    meta = item.meta
    body: dict[str, object] = {
        "id": str(meta.id),
        "title": meta.title,
        "model": meta.settings.model,
        "message_count": meta.message_count,
        "created_at": iso(meta.created_at),
        "updated_at": iso(meta.updated_at),
    }
    if search:
        body["snippet"] = item.snippet
    return body


def _parse_id(value: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError as exc:
        raise conversation_not_found() from exc


Store = Annotated[ConversationStore, Depends(get_conversations)]


@router.post("/conversations", status_code=201)
async def create(body: CreateIn, store: Store) -> dict[str, object]:
    title = _title(body.title)
    messages = [_message(m) for m in body.messages]
    conversation = await store.create(title, body.settings.to_settings(), messages)
    return conversation_json(conversation)


@router.get("/conversations")
async def list_conversations(
    store: Store,
    q: str | None = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    before: str | None = None,
) -> dict[str, object]:
    query = ListQuery(
        q=(q or "").strip() or None,
        limit=limit,
        before=decode_position(before) if before else None,
    )
    page = await store.list(query)
    return {
        "data": [item_json(i, search=query.q is not None) for i in page.items],
        "next": None if page.next is None else encode_position(*page.next),
    }


@router.get("/conversations/{cid}")
async def get_conversation(cid: str, store: Store) -> dict[str, object]:
    conversation = await store.get(_parse_id(cid))
    if conversation is None:
        raise conversation_not_found()
    return conversation_json(conversation)


@router.patch("/conversations/{cid}")
async def patch_conversation(cid: str, body: PatchIn, store: Store) -> dict[str, object]:
    conversation_id = _parse_id(cid)
    if body.title is None and body.settings is None:
        raise GatewayError(400, "invalid_request_error", "Нужно поле title или settings")
    meta = await store.update_meta(
        conversation_id,
        title=None if body.title is None else _title(body.title),
        settings=None if body.settings is None else body.settings.to_settings(),
    )
    if meta is None:
        raise conversation_not_found()
    return meta_json(meta)


@router.put("/conversations/{cid}/messages")
async def replace_tail(
    cid: str,
    store: Store,
    body: Annotated[TailIn, Body()],
    start: Annotated[int, Query(alias="from", ge=0)],
) -> dict[str, object]:
    conversation_id = _parse_id(cid)
    messages = [_message(m) for m in body.messages]
    meta = await store.replace_tail(
        conversation_id, revision=body.revision, start=start, messages=messages
    )
    return {
        "revision": meta.revision,
        "updated_at": iso(meta.updated_at),
        "message_count": meta.message_count,
    }


@router.delete("/conversations/{cid}", status_code=204)
async def delete_conversation(cid: str, store: Store) -> Response:
    if not await store.delete(_parse_id(cid)):
        raise conversation_not_found()
    return Response(status_code=204)
