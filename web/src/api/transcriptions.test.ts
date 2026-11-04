import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearApiKey, onUnauthorized, setApiKey } from "./apiKey";
import { ApiError } from "./errors";
import {
  cancelTranscription,
  createTranscription,
  deleteTranscription,
  getAudio,
  getResult,
  getTranscription,
  listTranscriptions,
  parseJob,
  renameTranscription,
  retryTranscription,
} from "./transcriptions";
import type { XhrLike } from "./xhr";

const JOB = {
  id: "6f1c",
  status: "running",
  source: "ui",
  title: "Совещание",
  filename: "meeting.m4a",
  model: "whisper-large-v3-turbo",
  language: null,
  duration: null,
  progress: 0.42,
  queue_position: null,
  error: null,
  has_audio: false,
  retryable: false,
  created_at: "2026-11-04T18:02:11Z",
  started_at: "2026-11-04T18:02:12Z",
  finished_at: null,
};

class FakeXhr extends EventTarget implements XhrLike {
  url = "";
  headers: Record<string, string> = {};
  body: FormData | null = null;
  status = 0;
  responseText = "";
  upload = new EventTarget();
  open(_method: string, url: string): void {
    this.url = url;
  }
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  getResponseHeader(): string | null {
    return null;
  }
  send(body: FormData): void {
    this.body = body;
  }
  abort(): void {
    this.dispatchEvent(new ProgressEvent("abort"));
  }
  respond(status: number, text: string): void {
    this.status = status;
    this.responseText = text;
    this.dispatchEvent(new ProgressEvent("load"));
  }
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<FetchFn>>;

function respond(status: number, body: unknown, type = "application/json"): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(status === 204 ? null : text, {
    status,
    headers: { "Content-Type": type },
  });
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

test("createTranscription: форма без гранулярностей и разбор ответа", async () => {
  setApiKey("k");
  const xhr = new FakeXhr();
  const file = new File(["x"], "meeting.m4a", { type: "audio/mp4" });
  const promise = createTranscription(
    file,
    { model: "whisper-base", language: "ru", title: null },
    {},
    () => xhr,
  );
  expect(xhr.url).toBe("/api/transcriptions");
  expect(xhr.headers["Authorization"]).toBe("Bearer k");
  expect(xhr.body?.get("model")).toBe("whisper-base");
  expect(xhr.body?.get("language")).toBe("ru");
  expect(xhr.body?.has("title")).toBe(false);
  expect(xhr.body?.has("timestamp_granularities[]")).toBe(false);
  xhr.respond(202, JSON.stringify({ ...JOB, status: "queued" }));
  expect((await promise).status).toBe("queued");
});

test("createTranscription передаёт название", () => {
  const xhr = new FakeXhr();
  void createTranscription(
    new File(["x"], "a.wav"),
    { model: "m", language: null, title: "Лекция" },
    {},
    () => xhr,
  );
  expect(xhr.body?.get("title")).toBe("Лекция");
  expect(xhr.body?.has("language")).toBe(false);
});

test("parseJob: валидный объект, мусор и ошибка", () => {
  expect(parseJob(JOB)).toEqual(JOB);
  expect(parseJob({ ...JOB, status: "weird" })).toBeNull();
  expect(parseJob({ ...JOB, id: 1 })).toBeNull();
  expect(parseJob(null)).toBeNull();
  const failed = { ...JOB, status: "failed", error: { code: "invalid_audio", message: "нет" } };
  expect(parseJob(failed)?.error).toEqual({ code: "invalid_audio", message: "нет" });
  expect(parseJob({ ...JOB, snippet: "«совещание»" })?.snippet).toBe("«совещание»");
});

test("listTranscriptions: параметры запроса и мусор в списке", async () => {
  fetchMock.mockResolvedValue(respond(200, { data: [JOB, { bogus: true }], next: "abc" }));
  const page = await listTranscriptions({ q: "план", before: "abc" });
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    "/api/transcriptions?q=%D0%BF%D0%BB%D0%B0%D0%BD&before=abc",
  );
  expect(page.data).toEqual([JOB]);
  expect(page.next).toBe("abc");
});

test("listTranscriptions без параметров", async () => {
  fetchMock.mockResolvedValue(respond(200, { data: [], next: null }));
  await listTranscriptions({});
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/transcriptions");
});

test("getTranscription и действия шлют ключ и нужный метод", async () => {
  setApiKey("k");
  fetchMock.mockImplementation(() => Promise.resolve(respond(200, JOB)));
  await getTranscription("6f1c");
  await cancelTranscription("6f1c");
  await retryTranscription("6f1c");
  await renameTranscription("6f1c", "Новое");
  const calls = fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"]);
  expect(calls).toEqual([
    ["/api/transcriptions/6f1c", "GET"],
    ["/api/transcriptions/6f1c/cancel", "POST"],
    ["/api/transcriptions/6f1c/retry", "POST"],
    ["/api/transcriptions/6f1c", "PATCH"],
  ]);
  const headers = new Headers(fetchMock.mock.calls[3]?.[1]?.headers);
  expect(headers.get("Authorization")).toBe("Bearer k");
  expect(headers.get("Content-Type")).toBe("application/json");
  expect(fetchMock.mock.calls[3]?.[1]?.body).toBe(JSON.stringify({ title: "Новое" }));
});

test("deleteTranscription: 204 без тела", async () => {
  fetchMock.mockResolvedValue(respond(204, ""));
  await expect(deleteTranscription("6f1c")).resolves.toBeUndefined();
  expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
});

test("getResult разбирает verbose_json со словами", async () => {
  fetchMock.mockResolvedValue(
    respond(200, {
      text: "Привет",
      language: "russian",
      duration: 1,
      segments: [{ id: 0, start: 0, end: 1, text: " Привет" }],
      words: [{ word: " Привет", start: 0, end: 1 }],
    }),
  );
  const result = await getResult("6f1c");
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/transcriptions/6f1c/result");
  expect(result.words).toHaveLength(1);
  expect(result.segments).toHaveLength(1);
});

test("getAudio шлёт ключ и возвращает Blob", async () => {
  setApiKey("k");
  fetchMock.mockResolvedValue(respond(200, "OPUS", "audio/webm"));
  const blob = await getAudio("6f1c");
  expect(await blob.text()).toBe("OPUS");
  const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
  expect(headers.get("Authorization")).toBe("Bearer k");
});

test("ошибка 409 — ApiError с текстом сервера", async () => {
  fetchMock.mockResolvedValue(
    respond(409, { error: { message: "Распознавание уже завершено", code: "invalid_state" } }),
  );
  const error: unknown = await cancelTranscription("6f1c").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect(error instanceof ApiError ? [error.message, error.code] : null).toEqual([
    "Распознавание уже завершено",
    "invalid_state",
  ]);
});

test("401 — вызывается обработчик ключа", async () => {
  const handler = vi.fn<() => void>();
  const off = onUnauthorized(handler);
  fetchMock.mockResolvedValue(respond(401, { error: { message: "нет ключа" } }));
  await getTranscription("x").catch(() => undefined);
  off();
  expect(handler).toHaveBeenCalledOnce();
});

test("сеть недоступна — понятная ошибка", async () => {
  fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
  await expect(getTranscription("x")).rejects.toThrow("Шлюз недоступен");
});
