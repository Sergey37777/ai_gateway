import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearApiKey, setApiKey } from "./apiKey";
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  parseConversation,
  patchConversation,
  replaceTail,
} from "./conversations";
import { ApiError } from "./errors";
import type { ApiChatSettings } from "./types";

const SETTINGS: ApiChatSettings = {
  model: "qwen3-0.6b",
  system_prompt: "",
  temperature: null,
  max_tokens: null,
  reasoning_effort: null,
};

const META = {
  id: "c1",
  title: "Котики",
  settings: SETTINGS,
  revision: 2,
  message_count: 2,
  created_at: "2026-11-08T10:00:00Z",
  updated_at: "2026-11-08T10:01:00Z",
};

const CONVERSATION = {
  ...META,
  messages: [
    {
      role: "user",
      text: "Что это?",
      images: [{ name: "a.png", data_url: "data:image/png;base64,AA" }],
    },
    {
      role: "assistant",
      text: "Кот",
      reasoning: "",
      status: "done",
      error: null,
      usage: { prompt_tokens: 3, completion_tokens: 1 },
      model: "qwen3-0.6b",
    },
  ],
};

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<FetchFn>>;

function respond(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function lastCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1);
  if (call === undefined) throw new Error("fetch не вызывался");
  return { url: call[0], init: call[1] ?? {} };
}

function bodyOf(init: RequestInit): unknown {
  if (typeof init.body !== "string") throw new Error("тело — не строка");
  return JSON.parse(init.body);
}

beforeEach(() => {
  clearApiKey();
  fetchMock = vi.fn<FetchFn>();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearApiKey();
});

test("parseConversation: корректный диалог", () => {
  const parsed = parseConversation(CONVERSATION);
  expect(parsed?.messages).toHaveLength(2);
  expect(parsed?.messages[0]).toEqual(CONVERSATION.messages[0]);
  expect(parsed?.revision).toBe(2);
});

test.each([
  ["нет revision", { ...CONVERSATION, revision: undefined }],
  ["роль system", { ...CONVERSATION, messages: [{ role: "system", text: "x" }] }],
  [
    "статус streaming",
    { ...CONVERSATION, messages: [{ ...CONVERSATION.messages[1], status: "streaming" }] },
  ],
  [
    "картинка без data_url",
    { ...CONVERSATION, messages: [{ role: "user", text: "", images: [{}] }] },
  ],
])("parseConversation отвергает: %s", (_name, value) => {
  expect(parseConversation(value)).toBeNull();
});

test("listConversations: поиск, ключ и разбор", async () => {
  setApiKey("k");
  const item = { ...META, model: "qwen3-0.6b", snippet: "«кот»" };
  fetchMock.mockResolvedValue(respond(200, { data: [item, { bogus: true }], next: "n1" }));
  const page = await listConversations({ q: "кот" });
  const { url, init } = lastCall();
  expect(url).toBe("/api/conversations?q=%D0%BA%D0%BE%D1%82");
  expect(new Headers(init.headers).get("Authorization")).toBe("Bearer k");
  expect(page.next).toBe("n1");
  expect(page.data).toEqual([
    {
      id: "c1",
      title: "Котики",
      model: "qwen3-0.6b",
      message_count: 2,
      created_at: META.created_at,
      updated_at: META.updated_at,
      snippet: "«кот»",
    },
  ]);
});

test("getConversation и createConversation", async () => {
  fetchMock.mockResolvedValue(respond(200, CONVERSATION));
  expect((await getConversation("c 1")).title).toBe("Котики");
  expect(lastCall().url).toBe("/api/conversations/c%201");
  fetchMock.mockResolvedValue(respond(201, CONVERSATION));
  const body = { title: "Котики", settings: SETTINGS, messages: [] };
  await createConversation(body);
  const { url, init } = lastCall();
  expect(url).toBe("/api/conversations");
  expect(init.method).toBe("POST");
  expect(bodyOf(init)).toEqual(body);
});

test("replaceTail: PUT …/messages?from=N", async () => {
  fetchMock.mockResolvedValue(
    respond(200, { revision: 3, updated_at: "2026-11-08T10:02:00Z", message_count: 3 }),
  );
  const result = await replaceTail("c1", 2, { revision: 2, messages: [] });
  const { url, init } = lastCall();
  expect(url).toBe("/api/conversations/c1/messages?from=2");
  expect(init.method).toBe("PUT");
  expect(bodyOf(init)).toEqual({ revision: 2, messages: [] });
  expect(result).toEqual({ revision: 3, updated_at: "2026-11-08T10:02:00Z", message_count: 3 });
});

test("replaceTail: 409 → ApiError с кодом conversation_conflict", async () => {
  fetchMock.mockResolvedValue(
    respond(409, {
      error: {
        message: "Диалог изменён",
        type: "invalid_request_error",
        code: "conversation_conflict",
      },
    }),
  );
  const error: unknown = await replaceTail("c1", 0, { revision: 0, messages: [] }).catch(
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect(error instanceof ApiError && error.code).toBe("conversation_conflict");
});

test("patchConversation и deleteConversation", async () => {
  fetchMock.mockResolvedValue(respond(200, META));
  expect((await patchConversation("c1", { title: "Новое" })).revision).toBe(2);
  expect(lastCall().init.method).toBe("PATCH");
  fetchMock.mockResolvedValue(respond(204, null));
  await deleteConversation("c1");
  expect(lastCall().init.method).toBe("DELETE");
});

test("ответ не прошёл проверку → ApiError «Некорректный ответ сервера»", async () => {
  fetchMock.mockResolvedValue(respond(200, { id: 1 }));
  await expect(getConversation("c1")).rejects.toThrow("Некорректный ответ сервера");
});
