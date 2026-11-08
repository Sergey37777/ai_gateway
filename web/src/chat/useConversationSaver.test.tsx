import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "../api/errors";
import type { ApiChatSettings, Conversation, TailResult } from "../api/types";
import type { ChatMessage } from "./state";
import { useConversationSaver, type SaverApi, type SaverOptions } from "./useConversationSaver";

const SETTINGS: ApiChatSettings = {
  model: "qwen3-0.6b",
  system_prompt: "",
  temperature: null,
  max_tokens: null,
  reasoning_effort: null,
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  const handlers: Partial<Pick<Deferred<T>, "resolve" | "reject">> = {};
  const promise = new Promise<T>((resolve, reject) => {
    handlers.resolve = resolve;
    handlers.reject = reject;
  });
  const { resolve, reject } = handlers;
  if (resolve === undefined || reject === undefined) throw new Error("Promise не вызвал executor");
  return { promise, resolve, reject };
}

const q = (id: number, text: string): ChatMessage => ({ id, role: "user", text, images: [] });
const a = (id: number, content: string, status: "done" | "streaming" = "done"): ChatMessage => ({
  id,
  role: "assistant",
  content,
  reasoning: "",
  status,
  usage: null,
  error: null,
  model: status === "done" ? "qwen3-0.6b" : null,
});

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "c1",
    title: "Привет",
    settings: SETTINGS,
    revision: 0,
    message_count: 1,
    created_at: "2026-11-08T10:00:00Z",
    updated_at: "2026-11-08T10:00:00Z",
    messages: [{ role: "user", text: "Привет", images: [] }],
    ...overrides,
  };
}

function tail(revision: number, count = 2): TailResult {
  return { revision, updated_at: `2026-11-08T10:0${String(revision)}:00Z`, message_count: count };
}

/** Фейковое API: каждый вызов возвращает следующий deferred из очереди. */
function fakeApi() {
  const creates: Deferred<Conversation>[] = [];
  const tails: Deferred<TailResult>[] = [];
  const patches: Deferred<Conversation>[] = [];
  const api = {
    createConversation: vi.fn<SaverApi["createConversation"]>(() => {
      const d = deferred<Conversation>();
      creates.push(d);
      return d.promise;
    }),
    replaceTail: vi.fn<SaverApi["replaceTail"]>(() => {
      const d = deferred<TailResult>();
      tails.push(d);
      return d.promise;
    }),
    patchConversation: vi.fn<SaverApi["patchConversation"]>(() => {
      const d = deferred<Conversation>();
      patches.push(d);
      return d.promise;
    }),
  } satisfies SaverApi;
  return { api, creates, tails, patches };
}

function setup() {
  const fake = fakeApi();
  const onCreated = vi.fn<SaverOptions["onCreated"]>();
  const onSaved = vi.fn<SaverOptions["onSaved"]>();
  const hook = renderHook(() => useConversationSaver({ api: fake.api, onCreated, onSaved }));
  return { ...fake, onCreated, onSaved, hook };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test("первая запись создаёт диалог с названием и первым вопросом", async () => {
  const { api, creates, onCreated, hook } = setup();
  act(() => {
    hook.result.current.sync([q(0, "Привет\nвторая строка"), a(1, "", "streaming")], SETTINGS);
  });
  expect(api.createConversation).toHaveBeenCalledWith({
    title: "Привет",
    settings: SETTINGS,
    messages: [{ role: "user", text: "Привет\nвторая строка", images: [] }],
  });
  expect(hook.result.current.status.kind).toBe("saving");
  expect(hook.result.current.unsaved).toBe(true);
  creates[0]?.resolve(
    conversation({ messages: [{ role: "user", text: "Привет\nвторая строка", images: [] }] }),
  );
  await settle();
  expect(onCreated).toHaveBeenCalledOnce();
  expect(hook.result.current.conversationId).toBe("c1");
  expect(hook.result.current.status.kind).toBe("idle");
});

test("записи идут по одной: вторая ждёт первую и берёт её revision", async () => {
  const { api, tails, onSaved, hook } = setup();
  act(() => {
    hook.result.current.reset(conversation());
  });
  act(() => {
    hook.result.current.sync([q(0, "Привет"), a(1, "Здравствуйте")], SETTINGS);
  });
  expect(api.replaceTail).toHaveBeenCalledTimes(1);
  expect(api.replaceTail).toHaveBeenLastCalledWith("c1", 1, {
    revision: 0,
    messages: [expect.objectContaining({ role: "assistant", text: "Здравствуйте" })],
  });
  act(() => {
    hook.result.current.sync(
      [q(0, "Привет"), a(1, "Здравствуйте"), q(2, "Ещё"), a(3, "", "streaming")],
      SETTINGS,
    );
  });
  expect(api.replaceTail).toHaveBeenCalledTimes(1);
  tails[0]?.resolve(tail(1));
  await settle();
  expect(api.replaceTail).toHaveBeenCalledTimes(2);
  expect(api.replaceTail).toHaveBeenLastCalledWith("c1", 2, {
    revision: 1,
    messages: [{ role: "user", text: "Ещё", images: [] }],
  });
  expect(onSaved).toHaveBeenCalledWith({ id: "c1", updated_at: "2026-11-08T10:01:00Z" });
});

test("сбой → error; retry повторяет ту же запись; дельты стрима не спамят повторами", async () => {
  const { api, tails, hook } = setup();
  act(() => {
    hook.result.current.reset(conversation());
  });
  const messages = [q(0, "Привет"), a(1, "Здравствуйте"), q(2, "Ещё"), a(3, "", "streaming")];
  act(() => {
    hook.result.current.sync(messages, SETTINGS);
  });
  tails[0]?.reject(new ApiError("База данных недоступна", 503, "database_unavailable"));
  await settle();
  expect(hook.result.current.status).toEqual({ kind: "error", message: "База данных недоступна" });
  act(() => {
    hook.result.current.sync([...messages.slice(0, 3), a(3, "ч", "streaming")], SETTINGS);
  });
  expect(api.replaceTail).toHaveBeenCalledTimes(1);
  act(() => {
    hook.result.current.retry();
  });
  expect(api.replaceTail).toHaveBeenCalledTimes(2);
  expect(api.replaceTail.mock.calls[1]).toEqual(api.replaceTail.mock.calls[0]);
  tails[1]?.resolve(tail(1, 3));
  await settle();
  expect(hook.result.current.status.kind).toBe("idle");
});

test("409 → conflict, дальше ничего не пишется до reset", async () => {
  const { api, tails, hook } = setup();
  act(() => {
    hook.result.current.reset(conversation());
  });
  act(() => {
    hook.result.current.sync([q(0, "Привет"), a(1, "Ответ")], SETTINGS);
  });
  tails[0]?.reject(new ApiError("Диалог изменён", 409, "conversation_conflict"));
  await settle();
  expect(hook.result.current.status.kind).toBe("conflict");
  act(() => {
    hook.result.current.sync([q(0, "Привет"), a(1, "Ответ"), q(2, "Ещё")], SETTINGS);
  });
  expect(api.replaceTail).toHaveBeenCalledTimes(1);
});

test("404 при записи → error «Диалог не найден»", async () => {
  const { tails, hook } = setup();
  act(() => {
    hook.result.current.reset(conversation());
  });
  act(() => {
    hook.result.current.sync([q(0, "Привет"), a(1, "Ответ")], SETTINGS);
  });
  tails[0]?.reject(new ApiError("Диалог не найден", 404, "conversation_not_found"));
  await settle();
  expect(hook.result.current.status).toEqual({ kind: "error", message: "Диалог не найден" });
});

test("настройки: две правки за 300 мс → один PATCH через 500 мс", async () => {
  const { api, patches, hook } = setup();
  act(() => {
    hook.result.current.reset(conversation());
  });
  const first = { ...SETTINGS, system_prompt: "К" };
  const second = { ...SETTINGS, system_prompt: "Кратко" };
  act(() => {
    hook.result.current.syncSettings(first);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  act(() => {
    hook.result.current.syncSettings(second);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(499);
  });
  expect(api.patchConversation).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(api.patchConversation).toHaveBeenCalledExactlyOnceWith("c1", { settings: second });
  patches[0]?.resolve(conversation({ settings: second }));
  await settle();
  expect(hook.result.current.status.kind).toBe("idle");
});

test("настройки до получения id уходят PATCH'ем после POST", async () => {
  const { api, creates, hook } = setup();
  act(() => {
    hook.result.current.sync([q(0, "Привет"), a(1, "", "streaming")], SETTINGS);
  });
  const changed = { ...SETTINGS, temperature: 0.5 };
  act(() => {
    hook.result.current.syncSettings(changed);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(api.patchConversation).not.toHaveBeenCalled();
  creates[0]?.resolve(conversation());
  await settle();
  expect(api.patchConversation).toHaveBeenCalledExactlyOnceWith("c1", { settings: changed });
});

test("flush: true после успешной записи, false после сбоя", async () => {
  const { tails, hook } = setup();
  act(() => {
    hook.result.current.reset(conversation());
  });
  act(() => {
    hook.result.current.sync([q(0, "Привет"), a(1, "Ответ")], SETTINGS);
  });
  let flushed: boolean | null = null;
  void hook.result.current.flush().then((value) => {
    flushed = value;
  });
  tails[0]?.resolve(tail(1));
  await settle();
  expect(flushed).toBe(true);

  act(() => {
    hook.result.current.sync([q(0, "Привет"), a(1, "Ответ"), q(2, "Ещё")], SETTINGS);
  });
  let failed: boolean | null = null;
  void hook.result.current.flush().then((value) => {
    failed = value;
  });
  tails[1]?.reject(new Error("сеть"));
  await settle();
  expect(failed).toBe(false);
  expect(await hook.result.current.flush()).toBe(false);
});

test("без изменений flush сразу true, а reset(null) — новый диалог", async () => {
  const { api, hook } = setup();
  expect(await hook.result.current.flush()).toBe(true);
  act(() => {
    hook.result.current.reset(null);
    hook.result.current.sync([], SETTINGS);
  });
  expect(api.createConversation).not.toHaveBeenCalled();
  expect(hook.result.current.conversationId).toBeNull();
});
