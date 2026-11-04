"""Чат через официальный OpenAI SDK на реальной Ollama (`pytest -m integration`).

Нужна запущенная Ollama (`AIGW_OLLAMA_URL`, по умолчанию http://localhost:11434) и модели
`qwen3:0.6b`, `qwen2.5vl:3b`; иначе соответствующие тесты пропускаются.
"""

import base64
import json
from collections.abc import AsyncIterator, Callable
from pathlib import Path

import httpx
import httpx2
import pytest
from fastapi import FastAPI
from openai import AsyncOpenAI
from openai.types.chat import ChatCompletionMessageParam

from ai_gateway.app import create_app
from ai_gateway.config import Settings
from tests.fakes import InMemoryTranscriptionStore

pytestmark = pytest.mark.integration

REPO_ROOT = Path(__file__).resolve().parent.parent
RED_PNG = REPO_ROOT / "tests" / "fixtures" / "red.png"

TEXT_MODEL = "qwen3-0.6b"
VISION_MODEL = "qwen2.5vl-3b"
OLLAMA_NAMES = {TEXT_MODEL: "qwen3:0.6b", VISION_MODEL: "qwen2.5vl:3b"}


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        _env_file=None,
        device="cpu",
        models_file=REPO_ROOT / "models.dev.yaml",
        data_dir=tmp_path / "data",
    )


@pytest.fixture
def require_model(settings: Settings) -> Callable[[str], None]:
    """Пропускает тест, если Ollama недоступна или в ней нет нужной модели."""
    url = settings.ollama_url

    def check(gateway_name: str) -> None:
        try:
            tags = httpx.get(f"{url}/api/tags", timeout=5).json()
        except httpx.HTTPError:
            pytest.skip(f"Ollama недоступна на {url}")
        pulled = {m["name"] for m in tags.get("models", [])}
        name = OLLAMA_NAMES[gateway_name]
        if name not in pulled:
            pytest.skip(f"Нет модели {name}: ollama pull {name}")

    return check


@pytest.fixture
async def app(settings: Settings) -> AsyncIterator[FastAPI]:
    # чату история распознаваний не нужна — PostgreSQL не требуется
    application = create_app(settings, store=InMemoryTranscriptionStore())
    async with application.router.lifespan_context(application):
        yield application


@pytest.fixture
async def openai_client(app: FastAPI) -> AsyncIterator[AsyncOpenAI]:
    # openai 3.x типизирует http_client как httpx2.AsyncClient; CPU-инференс медленный
    async with httpx2.AsyncClient(
        transport=httpx2.ASGITransport(app=app), base_url="http://test", timeout=300
    ) as http_client:
        yield AsyncOpenAI(base_url="http://test/v1", api_key="x", http_client=http_client)


async def test_sdk_chat(openai_client, require_model):
    require_model(TEXT_MODEL)
    r = await openai_client.chat.completions.create(
        model=TEXT_MODEL,
        messages=[{"role": "user", "content": "Скажи привет одним словом."}],
        temperature=0,
        seed=1,
        reasoning_effort="none",
    )
    assert r.model == TEXT_MODEL
    assert r.choices[0].finish_reason == "stop"
    content = r.choices[0].message.content
    assert isinstance(content, str) and content.strip()


async def test_sdk_stream(openai_client, require_model):
    require_model(TEXT_MODEL)
    stream = await openai_client.chat.completions.create(
        model=TEXT_MODEL,
        messages=[{"role": "user", "content": "Скажи привет одним словом."}],
        temperature=0,
        seed=1,
        reasoning_effort="none",
        stream=True,
    )
    parts: list[str] = []
    finish_reasons: list[str | None] = []
    async for chunk in stream:
        if not chunk.choices:
            continue
        parts.append(chunk.choices[0].delta.content or "")
        finish_reasons.append(chunk.choices[0].finish_reason)
    assert "".join(parts).strip()
    assert finish_reasons[-1] == "stop"


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Возвращает текущую погоду в городе",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string", "description": "Название города"}},
                "required": ["city"],
            },
        },
    }
]


async def test_sdk_tool_call_roundtrip(openai_client, require_model):
    require_model(TEXT_MODEL)
    messages: list[ChatCompletionMessageParam] = [
        {"role": "user", "content": "Какая погода в Москве? Вызови инструмент."}
    ]
    r = await openai_client.chat.completions.create(
        model=TEXT_MODEL,
        messages=messages,
        tools=TOOLS,
        temperature=0,
        seed=1,
        reasoning_effort="none",
    )
    choice = r.choices[0]
    assert choice.finish_reason == "tool_calls"
    assert choice.message.tool_calls
    call = choice.message.tool_calls[0]
    assert call.function.name == "get_weather"
    assert "city" in json.loads(call.function.arguments)

    messages += [
        {
            "role": "assistant",
            "content": choice.message.content or "",
            "tool_calls": [
                {
                    "id": call.id,
                    "type": "function",
                    "function": {"name": call.function.name, "arguments": call.function.arguments},
                }
            ],
        },
        {"role": "tool", "tool_call_id": call.id, "content": "+5 °C"},
    ]
    r2 = await openai_client.chat.completions.create(
        model=TEXT_MODEL,
        messages=messages,
        tools=TOOLS,
        temperature=0,
        seed=1,
        reasoning_effort="none",
    )
    content = r2.choices[0].message.content
    assert isinstance(content, str) and content.strip()


async def test_sdk_reasoning(openai_client, require_model):
    require_model(TEXT_MODEL)
    r = await openai_client.chat.completions.create(
        model=TEXT_MODEL,
        messages=[{"role": "user", "content": "Сколько будет 12 умножить на 7?"}],
        temperature=0,
        seed=1,
    )
    extra = r.choices[0].message.model_extra
    assert extra is not None
    reasoning = extra.get("reasoning_content")
    assert isinstance(reasoning, str) and reasoning.strip()


async def test_sdk_image(openai_client, require_model):
    require_model(VISION_MODEL)
    data_url = "data:image/png;base64," + base64.b64encode(RED_PNG.read_bytes()).decode()
    r = await openai_client.chat.completions.create(
        model=VISION_MODEL,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Какого цвета картинка? Одно слово."},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
        temperature=0,
        seed=1,
    )
    content = (r.choices[0].message.content or "").lower()
    assert "крас" in content or "red" in content
