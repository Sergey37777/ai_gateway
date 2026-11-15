import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "../api/errors";
import type { ApiDocument, TextWriteResult } from "../api/types";
import { SAVE_DELAY, useDocumentSaver, type DocumentSaverOptions } from "./useDocumentSaver";

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

const DOC: ApiDocument = {
  id: "d1",
  title: "Спека",
  filename: "spec.md",
  format: "markdown",
  chars: 4,
  revision: 2,
  question_count: 0,
  created_at: "2026-11-15T10:00:00Z",
  updated_at: "2026-11-15T10:00:00Z",
  text: "было",
};

function result(revision: number): TextWriteResult {
  return { revision, updated_at: `2026-11-15T10:0${String(revision)}:00Z`, chars: 1 };
}

function setup() {
  const writes: Deferred<TextWriteResult>[] = [];
  const writeText = vi.fn<DocumentSaverOptions["writeText"]>(() => {
    const d = deferred<TextWriteResult>();
    writes.push(d);
    return d.promise;
  });
  const onSaved = vi.fn<DocumentSaverOptions["onSaved"]>();
  const hook = renderHook(() => useDocumentSaver({ writeText, onSaved }));
  act(() => {
    hook.result.current.reset(DOC);
  });
  return { writes, writeText, onSaved, hook };
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

test("запись — через SAVE_DELAY после последней правки", async () => {
  const { writes, writeText, onSaved, hook } = setup();
  expect(SAVE_DELAY).toBe(1500);
  act(() => {
    hook.result.current.edit("а");
  });
  act(() => {
    vi.advanceTimersByTime(1000);
    hook.result.current.edit("аб");
  });
  expect(hook.result.current.unsaved).toBe(true);
  act(() => {
    vi.advanceTimersByTime(1499);
  });
  expect(writeText).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(writeText).toHaveBeenCalledWith("d1", { revision: 2, text: "аб" });
  expect(hook.result.current.status.kind).toBe("saving");
  writes[0]?.resolve(result(3));
  await settle();
  expect(hook.result.current.status.kind).toBe("idle");
  expect(hook.result.current.unsaved).toBe(false);
  expect(onSaved).toHaveBeenCalledWith(result(3));
});

test("правка во время записи уходит следующей записью с новым revision", async () => {
  const { writes, writeText, hook } = setup();
  act(() => {
    hook.result.current.edit("один");
    vi.advanceTimersByTime(SAVE_DELAY);
  });
  act(() => {
    hook.result.current.edit("два");
    vi.advanceTimersByTime(SAVE_DELAY);
  });
  expect(writeText).toHaveBeenCalledOnce();
  writes[0]?.resolve(result(3));
  await settle();
  expect(writeText).toHaveBeenLastCalledWith("d1", { revision: 3, text: "два" });
});

test("flush пишет сразу и ждёт окончания", async () => {
  const { writes, writeText, hook } = setup();
  act(() => {
    hook.result.current.edit("срочно");
  });
  let done: boolean | null = null;
  act(() => {
    void hook.result.current.flush().then((ok) => {
      done = ok;
    });
  });
  expect(writeText).toHaveBeenCalledWith("d1", { revision: 2, text: "срочно" });
  writes[0]?.resolve(result(3));
  await settle();
  expect(done).toBe(true);
  // нечего писать — сразу true
  let empty: boolean | null = null;
  await act(async () => {
    empty = await hook.result.current.flush();
  });
  expect(empty).toBe(true);
});

test("сбой → error; retry пишет снова, следующая правка — тоже", async () => {
  const { writes, writeText, hook } = setup();
  act(() => {
    hook.result.current.edit("x");
    vi.advanceTimersByTime(SAVE_DELAY);
  });
  writes[0]?.reject(new ApiError("База данных недоступна", 503, "database_unavailable"));
  await settle();
  expect(hook.result.current.status).toEqual({
    kind: "error",
    message: "База данных недоступна",
  });
  act(() => {
    vi.advanceTimersByTime(SAVE_DELAY * 3);
  });
  expect(writeText).toHaveBeenCalledOnce();
  act(() => {
    hook.result.current.retry();
  });
  expect(writeText).toHaveBeenCalledTimes(2);
  writes[1]?.reject(new Error("сеть"));
  await settle();
  act(() => {
    hook.result.current.edit("xy");
    vi.advanceTimersByTime(SAVE_DELAY);
  });
  expect(writeText).toHaveBeenLastCalledWith("d1", { revision: 2, text: "xy" });
});

test("409 → conflict, дальше не пишет; reset снимает конфликт", async () => {
  const { writes, writeText, hook } = setup();
  act(() => {
    hook.result.current.edit("моё");
    vi.advanceTimersByTime(SAVE_DELAY);
  });
  writes[0]?.reject(new ApiError("Документ изменён", 409, "document_conflict"));
  await settle();
  expect(hook.result.current.status.kind).toBe("conflict");
  act(() => {
    hook.result.current.edit("ещё");
    vi.advanceTimersByTime(SAVE_DELAY);
  });
  expect(writeText).toHaveBeenCalledOnce();
  let ok: boolean | null = null;
  await act(async () => {
    ok = await hook.result.current.flush();
  });
  expect(ok).toBe(false);
  act(() => {
    hook.result.current.reset({ ...DOC, revision: 5, text: "чужое" });
  });
  expect(hook.result.current.status.kind).toBe("idle");
  expect(hook.result.current.unsaved).toBe(false);
});
