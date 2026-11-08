"""API диалогов чата `/api/conversations…` (фейковое хранилище)."""

import uuid
from typing import Any  # JSON запросов и ответов в тестах

import pytest

from tests.conftest import GatewayClient, MakeClient

URL = "/api/conversations"
SETTINGS: dict[str, Any] = {
    "model": "qwen3-14b",
    "system_prompt": "",
    "temperature": None,
    "max_tokens": None,
    "reasoning_effort": None,
}
IMAGE = {"name": "cat.png", "data_url": "data:image/png;base64,iVBORw0KGgo="}


def user(text: str = "Привет", images: list[dict[str, str]] | None = None) -> dict[str, Any]:
    return {"role": "user", "text": text, "images": images or []}


def assistant(text: str = "Здравствуйте", **extra: Any) -> dict[str, Any]:
    return {
        "role": "assistant",
        "text": text,
        "reasoning": "",
        "status": "done",
        "error": None,
        "usage": {"prompt_tokens": 5, "completion_tokens": 2},
        "model": "qwen3-14b",
        **extra,
    }


async def create(client: GatewayClient, **body: Any) -> dict[str, Any]:
    payload = {"title": "Привет", "settings": SETTINGS, "messages": [user()], **body}
    r = await client.post(URL, json=payload)
    assert r.status_code == 201, r.text
    data: dict[str, Any] = r.json()
    return data


async def test_create_returns_201_and_get(make_client):
    client = await make_client()
    body = await create(client, title="  Привет  ", messages=[user(images=[IMAGE]), assistant()])
    assert body["title"] == "Привет"
    assert body["revision"] == 0
    assert body["message_count"] == 2
    assert body["settings"] == SETTINGS
    assert body["created_at"].endswith("Z")
    got = (await client.get(f"{URL}/{body['id']}")).json()
    assert got == body
    assert got["messages"] == [user(images=[IMAGE]), assistant()]


@pytest.mark.parametrize(
    ("change", "param"),
    [
        ({"title": "   "}, "title"),
        ({"title": "x" * 201}, "title"),
        ({"settings": {**SETTINGS, "temperature": 3}}, "temperature"),
        ({"settings": {**SETTINGS, "max_tokens": 0}}, "max_tokens"),
        ({"settings": {**SETTINGS, "reasoning_effort": "max"}}, "reasoning_effort"),
        ({"settings": {**SETTINGS, "model": ""}}, "model"),
        ({"messages": [user(images=[{"name": "a", "data_url": "http://x/a.png"}])]}, "data_url"),
        ({"messages": [{**user(), "status": "done"}]}, "status"),
        ({"messages": [{**user(), "extra": 1}]}, "extra"),
        ({"messages": [{"role": "system", "text": "x"}]}, "role"),
        ({"messages": [user("плохой\x00текст")]}, "text"),
        (
            {"messages": [user(images=[{"name": "a", "data_url": "data:image/png;base64,\x00"}])]},
            "data_url",
        ),
    ],
)
async def test_create_validation(
    make_client: MakeClient, change: dict[str, Any], param: str
) -> None:
    client = await make_client()
    payload = {"title": "Привет", "settings": SETTINGS, "messages": [user()], **change}
    r = await client.post(URL, json=payload)
    assert r.status_code == 400, r.text
    error = r.json()["error"]
    assert error["code"] == "invalid_request_error"
    assert error["param"] == param


async def test_assistant_error_requires_message(make_client):
    client = await make_client()
    r = await client.post(
        URL,
        json={
            "title": "x",
            "settings": SETTINGS,
            "messages": [user(), assistant(status="error", error=None)],
        },
    )
    assert r.status_code == 400
    assert r.json()["error"]["param"] == "error"


async def test_list_and_search(make_client):
    client = await make_client()
    first = await create(client, title="Котики", messages=[user("Привет")])
    second = await create(client, title="Разное", messages=[user("Расскажи про котиков")])
    page = (await client.get(URL)).json()
    assert [i["id"] for i in page["data"]] == [second["id"], first["id"]]
    assert page["next"] is None
    item = page["data"][0]
    assert item == {
        "id": second["id"],
        "title": "Разное",
        "model": "qwen3-14b",
        "message_count": 1,
        "created_at": second["created_at"],
        "updated_at": second["updated_at"],
    }
    found = (await client.get(URL, params={"q": "котик"})).json()["data"]
    snippets = {i["id"]: i.get("snippet") for i in found}
    assert snippets == {first["id"]: None, second["id"]: "Расскажи про котиков"}
    limited = (await client.get(URL, params={"limit": 1})).json()
    assert limited["next"] is not None
    rest = (await client.get(URL, params={"limit": 1, "before": limited["next"]})).json()
    assert [i["id"] for i in rest["data"]] == [first["id"]]


async def test_list_bad_cursor(make_client):
    client = await make_client()
    r = await client.get(URL, params={"before": "!!"})
    assert r.status_code == 400
    assert r.json()["error"]["param"] == "before"


async def test_patch_title_and_settings(make_client):
    client = await make_client()
    body = await create(client)
    other = {**SETTINGS, "system_prompt": "Кратко", "temperature": 0.5}
    r = await client.patch(f"{URL}/{body['id']}", json={"title": " Новое ", "settings": other})
    assert r.status_code == 200, r.text
    meta = r.json()
    assert (meta["title"], meta["settings"], meta["revision"]) == ("Новое", other, 0)
    assert meta["updated_at"] == body["updated_at"]
    assert "messages" not in meta
    empty = await client.patch(f"{URL}/{body['id']}", json={})
    assert empty.status_code == 400


async def test_put_tail(make_client):
    client = await make_client()
    body = await create(client)
    r = await client.put(
        f"{URL}/{body['id']}/messages",
        params={"from": 1},
        json={"revision": 0, "messages": [assistant(), user("Ещё")]},
    )
    assert r.status_code == 200, r.text
    result = r.json()
    assert result["revision"] == 1
    assert result["message_count"] == 3
    assert result["updated_at"] > body["updated_at"]
    got = (await client.get(f"{URL}/{body['id']}")).json()
    assert [m["text"] for m in got["messages"]] == ["Привет", "Здравствуйте", "Ещё"]


async def test_put_conflict(make_client):
    client = await make_client()
    body = await create(client)
    r = await client.put(
        f"{URL}/{body['id']}/messages", params={"from": 1}, json={"revision": 3, "messages": []}
    )
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "conversation_conflict"


async def test_put_from_out_of_range(make_client):
    client = await make_client()
    body = await create(client)
    r = await client.put(
        f"{URL}/{body['id']}/messages", params={"from": 5}, json={"revision": 0, "messages": []}
    )
    assert r.status_code == 400
    assert r.json()["error"]["param"] == "from"
    negative = await client.put(
        f"{URL}/{body['id']}/messages", params={"from": -1}, json={"revision": 0, "messages": []}
    )
    assert negative.status_code == 400


@pytest.mark.parametrize("cid", [str(uuid.uuid4()), "abc"])
async def test_not_found(make_client: MakeClient, cid: str) -> None:
    client = await make_client()
    tail = {"revision": 0, "messages": []}
    responses = [
        await client.get(f"{URL}/{cid}"),
        await client.patch(f"{URL}/{cid}", json={"title": "x"}),
        await client.put(f"{URL}/{cid}/messages", params={"from": 0}, json=tail),
        await client.delete(f"{URL}/{cid}"),
    ]
    for r in responses:
        assert r.status_code == 404, r.text
        assert r.json()["error"]["code"] == "conversation_not_found"


async def test_delete(make_client):
    client = await make_client()
    body = await create(client)
    assert (await client.delete(f"{URL}/{body['id']}")).status_code == 204
    assert (await client.get(f"{URL}/{body['id']}")).status_code == 404


async def test_body_limit(make_client):
    client = await make_client(max_upload_mb=1)
    big = {"name": "big.png", "data_url": "data:image/png;base64," + "A" * (3 * 1024 * 1024)}
    r = await client.post(
        URL, json={"title": "x", "settings": SETTINGS, "messages": [user(images=[big])]}
    )
    assert r.status_code == 413
    assert r.json()["error"]["code"] == "request_too_large"
    body = await create(client)
    r = await client.put(
        f"{URL}/{body['id']}/messages",
        params={"from": 1},
        json={"revision": 0, "messages": [user(images=[big])]},
    )
    assert r.status_code == 413
    assert r.json()["error"]["code"] == "request_too_large"


async def test_api_key_required(make_client):
    client = await make_client(api_key="secret")
    assert (await client.get(URL)).status_code == 401
    ok = await client.get(URL, headers={"Authorization": "Bearer secret"})
    assert ok.status_code == 200


async def test_chat_completions_not_saved(make_client):
    client = await make_client()
    client.ollama.queue_fixture("complete_basic")
    r = await client.post(
        "/v1/chat/completions",
        json={"model": "qwen3-14b", "messages": [{"role": "user", "content": "Привет"}]},
    )
    assert r.status_code == 200
    assert (await client.get(URL)).json()["data"] == []
