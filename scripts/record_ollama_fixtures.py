"""Запись ответов Ollama в фикстуры тестов (`tests/fixtures/ollama`).

Запуск: `uv run python scripts/record_ollama_fixtures.py [--url ...] [--out ...]`.
Нужна работающая Ollama с моделями `qwen3:0.6b` и `qwen2.5vl:3b`.
Скрипт идемпотентен: перезаписывает фикстуры и при отсутствии создаёт `tests/fixtures/red.png`.
"""

import argparse
import base64
import json
import struct
import zlib
from pathlib import Path

import httpx

TEXT_MODEL = "qwen3:0.6b"
VISION_MODEL = "qwen2.5vl:3b"
TIMEOUT = 300.0

WEATHER_TOOL = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Получить погоду в городе",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}
COMMON = {"temperature": 0, "seed": 1}


def make_red_png(size: int = 32) -> bytes:
    """Сплошной красный PNG size x size (только stdlib)."""

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    row = b"\x00" + b"\xff\x00\x00" * size
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(row * size))
        + chunk(b"IEND", b"")
    )


class Recorder:
    def __init__(self, url: str, out: Path) -> None:
        self.client = httpx.Client(base_url=url, timeout=TIMEOUT)
        self.out = out
        self.out.mkdir(parents=True, exist_ok=True)
        self.notes: dict[str, str] = {}

    def post(self, payload: dict[str, object]) -> httpx.Response:
        return self.client.post("/v1/chat/completions", json=payload)

    def save_json(self, name: str, resp: httpx.Response, only_ok: bool = False) -> object:
        try:
            body: object = resp.json()
        except ValueError:
            body = resp.text
        if only_ok and resp.status_code != 200:
            (self.out / f"{name}.json").unlink(missing_ok=True)
            self.notes[name] = f"НЕ записано: HTTP {resp.status_code} {resp.text[:200]}"
            print(f"[{name}] HTTP {resp.status_code} - не записано")
            return body
        data = {"status": resp.status_code, "body": body}
        (self.out / f"{name}.json").write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"[{name}] HTTP {resp.status_code}")
        return body

    def stream(
        self, name: str, payload: dict[str, object], save: bool = True
    ) -> list[dict[str, object]]:
        payload = {**payload, "stream": True}
        with self.client.stream("POST", "/v1/chat/completions", json=payload) as resp:
            raw = resp.read()
            status = resp.status_code
        if save:
            (self.out / f"{name}.sse").write_bytes(raw)
        print(f"[{name}] HTTP {status}, {len(raw)} байт")
        chunks: list[dict[str, object]] = []
        for line in raw.decode("utf-8").splitlines():
            if line.startswith("data: ") and line != "data: [DONE]":
                chunks.append(json.loads(line[6:]))
        return chunks

    def run(self) -> None:
        red = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "red.png"
        if not red.exists():
            red.write_bytes(make_red_png())
        weather = [{"role": "user", "content": "What is the weather in Paris? Use the tool."}]
        basic = [{"role": "user", "content": "Скажи одно слово: привет"}]
        reason = [{"role": "user", "content": "Сколько будет 17 + 25?"}]

        # Версия
        self.notes["version"] = str(self.client.get("/api/version").json())

        # Обычные и стрим
        m = {"model": TEXT_MODEL, **COMMON}
        quiet = {**m, "reasoning_effort": "none"}  # без мышления: непустой content
        self.save_json("complete_basic", self.post({**quiet, "messages": basic, "max_tokens": 200}))
        self.stream("stream_basic", {**quiet, "messages": basic, "max_tokens": 200})

        # Tool calls
        tool_req = {**m, "messages": weather, "tools": [WEATHER_TOOL]}
        self.save_json("complete_tool_call", self.post(tool_req))
        self.stream("stream_tool_call", tool_req)

        two = {
            **m,
            "messages": [
                {
                    "role": "user",
                    "content": "Get the weather in Paris and in Tokyo at the same time. "
                    "Call get_weather twice in parallel.",
                }
            ],
            "tools": [WEATHER_TOOL],
        }
        chunks = self.stream("stream_parallel_tool_calls", two, save=False)
        n_calls = 0
        for chunk in chunks:
            for choice in chunk.get("choices", []):  # type: ignore[attr-defined]
                n_calls += len(choice.get("delta", {}).get("tool_calls") or [])
        if n_calls >= 2:
            self.stream("stream_parallel_tool_calls", two)
            self.notes["parallel"] = f"записано, вызовов: {n_calls}"
        else:
            stale = self.out / "stream_parallel_tool_calls.sse"
            stale.unlink(missing_ok=True)
            self.notes["parallel"] = f"модель выдала вызовов: {n_calls}, не записано"

        # Reasoning
        rq = {**m, "messages": reason, "max_tokens": 1500}
        self.save_json("complete_reasoning", self.post(rq))
        self.stream("stream_reasoning", rq)
        low = self.post({**rq, "reasoning_effort": "low"})
        self.notes["effort_low"] = json.dumps(
            low.json()["choices"][0]["message"], ensure_ascii=False
        )[:300]
        none = self.post({**rq, "reasoning_effort": "none"})
        self.notes["effort_none"] = json.dumps(
            none.json()["choices"][0]["message"], ensure_ascii=False
        )[:300]

        # usage в стриме
        self.stream(
            "stream_usage",
            {
                **quiet,
                "messages": basic,
                "max_tokens": 50,
                "stream_options": {"include_usage": True},
            },
        )

        # Картинка
        data_url = "data:image/png;base64," + base64.b64encode(red.read_bytes()).decode()
        self.save_json(
            "complete_image",
            self.post(
                {
                    "model": VISION_MODEL,
                    **COMMON,
                    "max_tokens": 30,
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": "What color is this image? One word."},
                                {"type": "image_url", "image_url": {"url": data_url}},
                            ],
                        }
                    ],
                }
            ),
            only_ok=True,
        )

        # Ошибки
        self.save_json(
            "error_model_not_found",
            self.post({"model": "no-such-model:1b", "messages": basic}),
        )
        self.save_json(
            "error_tools_unsupported",
            self.post({"model": VISION_MODEL, "messages": weather, "tools": [WEATHER_TOOL]}),
        )

        # developer
        self.save_json(
            "developer_role",
            self.post(
                {
                    **quiet,
                    "max_tokens": 200,
                    "messages": [
                        {"role": "developer", "content": "Отвечай только словом PONG"},
                        {"role": "user", "content": "Привет"},
                    ],
                }
            ),
        )

        # keep_alive: принимает ли тело и выгружает ли модель
        ka = self.post({**m, "messages": basic, "max_tokens": 20, "keep_alive": 0})
        ps = self.client.get("/api/ps").json()
        self.notes["keep_alive"] = (
            f"HTTP {ka.status_code}; /api/ps models={[x['name'] for x in ps.get('models', [])]}"
        )

        # Ошибка при чрезмерном контексте (проба OOM, не сохраняется)
        try:
            big = self.post(
                {**m, "messages": basic, "options": {"num_ctx": 100_000_000}, "max_tokens": 5}
            )
            self.notes["oom_probe"] = f"HTTP {big.status_code}: {big.text[:300]}"
        except httpx.HTTPError as exc:
            self.notes["oom_probe"] = f"{type(exc).__name__}"

        print("\n=== Сводка по §4.5 ===")
        for key, value in self.notes.items():
            print(f"{key}: {value}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://localhost:11434")
    parser.add_argument("--out", type=Path, default=Path("tests/fixtures/ollama"))
    args = parser.parse_args()
    Recorder(args.url, args.out).run()


if __name__ == "__main__":
    main()
