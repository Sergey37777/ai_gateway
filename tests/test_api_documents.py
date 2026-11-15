"""API документов `/api/documents…` (фейковое хранилище)."""

import uuid
from typing import Any  # JSON запросов и ответов в тестах

import pytest

from tests.conftest import GatewayClient

URL = "/api/documents"
TEXT = "# Спека\n\nПро котиков и документы."
SETTINGS: dict[str, Any] = {
    "model": "qwen3-14b",
    "system_prompt": "",
    "temperature": None,
    "max_tokens": None,
    "reasoning_effort": None,
}


async def create(client: GatewayClient, **body: Any) -> dict[str, Any]:
    payload = {"title": "Спека", "filename": "spec.md", "format": "markdown", "text": TEXT, **body}
    r = await client.post(URL, json=payload)
    assert r.status_code == 201, r.text
    data: dict[str, Any] = r.json()
    return data


async def ask(client: GatewayClient, did: str) -> dict[str, Any]:
    r = await client.post(
        "/api/conversations",
        json={
            "title": "Вопрос",
            "settings": SETTINGS,
            "messages": [{"role": "user", "text": "Что это?", "images": []}],
            "document": {"id": did, "quote": "котиков", "context": TEXT},
        },
    )
    assert r.status_code == 201, r.text
    data: dict[str, Any] = r.json()
    return data


async def test_create_and_get(make_client):
    client = await make_client()
    body = await create(client, title="  Спека  ")
    assert body["title"] == "Спека"
    assert (body["filename"], body["format"], body["text"]) == ("spec.md", "markdown", TEXT)
    assert (body["chars"], body["revision"], body["question_count"]) == (len(TEXT), 0, 0)
    assert body["created_at"].endswith("Z")
    got = (await client.get(f"{URL}/{body['id']}")).json()
    assert got == body


@pytest.mark.parametrize("did", [str(uuid.uuid4()), "не-uuid"])
async def test_get_404(make_client, did):
    client = await make_client()
    r = await client.get(f"{URL}/{did}")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "document_not_found"


async def test_list_cursor_search_snippet(make_client):
    client = await make_client()
    first = await create(client, title="Котики", text="Привет")
    second = await create(client, title="Разное", text="Расскажи про котиков")
    page = (await client.get(URL)).json()
    assert [i["id"] for i in page["data"]] == [second["id"], first["id"]]
    item = page["data"][0]
    assert "text" not in item
    assert item["chars"] == len("Расскажи про котиков")
    assert "snippet" not in item
    found = (await client.get(URL, params={"q": "котик"})).json()["data"]
    assert {i["id"]: i["snippet"] for i in found} == {
        first["id"]: None,
        second["id"]: "Расскажи про котиков",
    }
    limited = (await client.get(URL, params={"limit": 1})).json()
    assert limited["next"] is not None
    rest = (await client.get(URL, params={"limit": 1, "before": limited["next"]})).json()
    assert [i["id"] for i in rest["data"]] == [first["id"]]


async def test_patch_title_changes_filename(make_client):
    client = await make_client()
    body = await create(client, filename="notes.md")
    r = await client.patch(f"{URL}/{body['id']}", json={"title": " Новое "})
    assert r.status_code == 200
    meta = r.json()
    assert (meta["title"], meta["filename"], meta["revision"]) == ("Новое", "Новое.md", 0)
    assert "text" not in meta
    plain = await create(client, filename="README", format="text")
    meta = (await client.patch(f"{URL}/{plain['id']}", json={"title": "Итог"})).json()
    assert meta["filename"] == "Итог"


async def test_put_text_revision_and_conflict(make_client):
    client = await make_client()
    body = await create(client)
    r = await client.put(f"{URL}/{body['id']}/text", json={"revision": 0, "text": "новый"})
    assert r.status_code == 200
    result = r.json()
    assert (result["revision"], result["chars"]) == (1, 5)
    assert result["updated_at"].endswith("Z")
    stale = await client.put(f"{URL}/{body['id']}/text", json={"revision": 0, "text": "старый"})
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "document_conflict"
    got = (await client.get(f"{URL}/{body['id']}")).json()
    assert (got["text"], got["revision"]) == ("новый", 1)


async def test_delete_cascades_questions(make_client):
    client = await make_client()
    body = await create(client)
    question = await ask(client, body["id"])
    got = (await client.get(f"{URL}/{body['id']}")).json()
    assert got["question_count"] == 1
    assert (await client.delete(f"{URL}/{body['id']}")).status_code == 204
    assert (await client.get(f"{URL}/{body['id']}")).status_code == 404
    assert (await client.get(f"/api/conversations/{question['id']}")).status_code == 404
    assert (await client.delete(f"{URL}/{body['id']}")).status_code == 404


@pytest.mark.parametrize(
    ("change", "param"),
    [
        ({"format": "html"}, "format"),
        ({"filename": "a/b.md"}, "filename"),
        ({"filename": ""}, "filename"),
        ({"title": "   "}, "title"),
        ({"text": "a\x00b"}, "text"),
        ({"extra": 1}, "extra"),
    ],
)
async def test_validation(make_client, change, param):
    client = await make_client()
    payload = {"title": "Спека", "filename": "spec.md", "format": "markdown", "text": TEXT}
    r = await client.post(URL, json={**payload, **change})
    assert r.status_code == 400, r.text
    assert r.json()["error"]["param"] == param


async def test_text_over_limit_413(make_client):
    client = await make_client(max_document_mb=1)
    big = "ж" * (512 * 1024 + 1)  # 1 МиБ + 2 байта в UTF-8
    r = await client.post(
        URL, json={"title": "Большой", "filename": "b.md", "format": "markdown", "text": big}
    )
    assert r.status_code == 413
    assert r.json()["error"]["code"] == "request_too_large"
    assert r.json()["error"]["param"] == "text"
    body = await create(client)
    r = await client.put(f"{URL}/{body['id']}/text", json={"revision": 0, "text": big})
    assert r.status_code == 413


async def test_guard_rejects_huge_body(make_client):
    # лимит документа свой: тело больше max_document_mb + 1 МиБ режет охранник
    client = await make_client(max_upload_mb=200, max_document_mb=1)
    big = "a" * (3 * 1024 * 1024)
    r = await client.post(
        URL, json={"title": "x", "filename": "x.md", "format": "markdown", "text": big}
    )
    assert r.status_code == 413
    assert r.json()["error"]["code"] == "request_too_large"


async def test_api_key_required(make_client):
    client = await make_client(api_key="secret")
    assert (await client.get(URL)).status_code == 401
    ok = await client.get(URL, headers={"Authorization": "Bearer secret"})
    assert ok.status_code == 200
