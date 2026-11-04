import { afterEach, expect, test, vi } from "vitest";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions";
import { clearApiKey, onUnauthorized, setApiKey } from "./apiKey";
import { streamChat, type ChatEvent } from "./chat";
import { ApiError, isAbortError } from "./errors";

const BODY: ChatCompletionCreateParamsStreaming = {
  model: "qwen3-0.6b",
  messages: [{ role: "user", content: "Привет" }],
  stream: true,
  stream_options: { include_usage: true },
};

function chunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    created: 1,
    model: "qwen3-0.6b",
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  })}\n\n`;
}

function sse(events: string[], init: ResponseInit = {}): typeof fetch {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(events.join(""), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        ...init,
      }),
    ),
  );
}

async function collect(stream: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

afterEach(() => {
  clearApiKey();
});

test("content, reasoning_content и usage", async () => {
  const fetchFn = sse([
    chunk({ role: "assistant", reasoning_content: "думаю" }),
    chunk({ content: "При" }),
    chunk({ content: "вет" }),
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`,
    "data: [DONE]\n\n",
  ]);
  const events = await collect(streamChat(BODY, new AbortController().signal, fetchFn));
  expect(events).toEqual([
    { type: "reasoning", text: "думаю" },
    { type: "content", text: "При" },
    { type: "content", text: "вет" },
    { type: "usage", usage: { prompt_tokens: 3, completion_tokens: 2 } },
  ]);
});

test("ключ уходит в Authorization, запрос — на /v1/chat/completions", async () => {
  setApiKey("k-1");
  const fetchFn = sse(["data: [DONE]\n\n"]);
  await collect(streamChat(BODY, new AbortController().signal, fetchFn));
  const [url, init] = vi.mocked(fetchFn).mock.calls[0] ?? [];
  const target = url instanceof Request ? url.url : url instanceof URL ? url.href : url;
  expect(target).toMatch(/\/v1\/chat\/completions$/);
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer k-1");
});

test("ошибка посреди стрима: сначала полученное, затем ApiError", async () => {
  const fetchFn = sse([
    chunk({ content: "Нача" }),
    `data: ${JSON.stringify({ error: { message: "Ollama оборвала поток", type: "server_error", param: null, code: "upstream_error" } })}\n\n`,
  ]);
  const events: ChatEvent[] = [];
  let caught: unknown = null;
  try {
    for await (const event of streamChat(BODY, new AbortController().signal, fetchFn)) {
      events.push(event);
    }
  } catch (error) {
    caught = error;
  }
  expect(events).toEqual([{ type: "content", text: "Нача" }]);
  expect(caught).toBeInstanceOf(ApiError);
  expect(caught instanceof ApiError ? [caught.code, caught.message] : null).toEqual([
    "upstream_error",
    "Ollama оборвала поток",
  ]);
});

test("503 до стрима — ApiError с Retry-After", async () => {
  const fetchFn = vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: {
            message: "Ollama недоступна",
            type: "server_error",
            param: null,
            code: "model_unavailable",
          },
        }),
        { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "30" } },
      ),
    ),
  );
  const caught: unknown = await collect(
    streamChat(BODY, new AbortController().signal, fetchFn),
  ).then(
    () => null,
    (e: unknown) => e,
  );
  expect(
    caught instanceof ApiError
      ? [caught.status, caught.code, caught.message, caught.retryAfter]
      : caught,
  ).toEqual([503, "model_unavailable", "Ollama недоступна", 30]);
});

test("401 — уведомление о ключе", async () => {
  const listener = vi.fn<() => void>();
  const unsubscribe = onUnauthorized(listener);
  const fetchFn = vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: {
            message: "Неверный ключ",
            type: "authentication_error",
            param: null,
            code: "invalid_api_key",
          },
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      ),
    ),
  );
  await collect(streamChat(BODY, new AbortController().signal, fetchFn)).catch(() => undefined);
  expect(listener).toHaveBeenCalledOnce();
  unsubscribe();
});

test("сеть недоступна", async () => {
  const fetchFn = vi.fn<typeof fetch>(() => Promise.reject(new TypeError("Failed to fetch")));
  const caught: unknown = await collect(
    streamChat(BODY, new AbortController().signal, fetchFn),
  ).then(
    () => null,
    (e: unknown) => e,
  );
  expect(caught instanceof ApiError ? caught.status : caught).toBeNull();
});

test("abort", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchFn = sse(["data: [DONE]\n\n"]);
  const caught: unknown = await collect(streamChat(BODY, controller.signal, fetchFn)).then(
    () => null,
    (e: unknown) => e,
  );
  expect(isAbortError(caught)).toBe(true);
});
