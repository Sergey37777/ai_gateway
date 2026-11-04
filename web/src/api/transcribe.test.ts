import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearApiKey, onUnauthorized, setApiKey } from "./apiKey";
import { ApiError, isAbortError } from "./errors";
import { transcribe, type XhrLike } from "./transcribe";

class FakeXhr extends EventTarget implements XhrLike {
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: FormData | null = null;
  aborted = false;
  status = 0;
  responseText = "";
  responseHeaders: Record<string, string> = {};
  upload = new EventTarget();

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  getResponseHeader(name: string): string | null {
    return this.responseHeaders[name] ?? null;
  }
  send(body: FormData): void {
    this.body = body;
  }
  abort(): void {
    this.aborted = true;
    this.dispatchEvent(new ProgressEvent("abort"));
  }
  respond(status: number, text: string, headers: Record<string, string> = {}): void {
    this.status = status;
    this.responseText = text;
    this.responseHeaders = headers;
    this.dispatchEvent(new ProgressEvent("load"));
  }
}

const VERBOSE = JSON.stringify({
  task: "transcribe",
  language: "english",
  duration: 2.0,
  text: "Hello world.",
  segments: [{ id: 0, start: 0, end: 2, text: " Hello world.", avg_logprob: -0.1 }],
});

const file = new File(["data"], "hello.wav", { type: "audio/wav" });
let xhr: FakeXhr;

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof ApiError))
    throw new Error(`ожидалась ApiError, получено ${String(error)}`);
  return error;
}

beforeEach(() => {
  xhr = new FakeXhr();
  clearApiKey();
});
afterEach(() => {
  clearApiKey();
});

test("поля формы, ключ и успешный ответ", async () => {
  setApiKey("k");
  const promise = transcribe(file, { model: "whisper-base", language: "ru" }, {}, () => xhr);
  expect([xhr.method, xhr.url]).toEqual(["POST", "/v1/audio/transcriptions"]);
  expect(xhr.headers["Authorization"]).toBe("Bearer k");
  const form = xhr.body;
  expect(form?.get("model")).toBe("whisper-base");
  expect(form?.get("language")).toBe("ru");
  expect(form?.get("response_format")).toBe("verbose_json");
  // слова нужны для подсветки и перемотки по словам
  expect(form?.getAll("timestamp_granularities[]")).toEqual(["segment", "word"]);
  const sent = form?.get("file");
  expect(sent instanceof File ? sent.name : null).toBe("hello.wav");
  xhr.respond(200, VERBOSE);
  const result = await promise;
  expect(result.text).toBe("Hello world.");
  expect(result.language).toBe("english");
  expect(result.segments).toEqual([{ id: 0, start: 0, end: 2, text: " Hello world." }]);
  expect(result.raw).toBe(VERBOSE);
});

test("слова разбираются, мусор отбрасывается", async () => {
  const promise = transcribe(file, { model: "m", language: null }, {}, () => xhr);
  const body = JSON.stringify({
    text: "Привет",
    segments: [],
    words: [{ word: " Привет", start: 0, end: 0.5 }, { word: 1 }, null],
  });
  xhr.respond(200, body);
  expect((await promise).words).toEqual([{ word: " Привет", start: 0, end: 0.5 }]);
});

test("нет поля words — пустой массив", async () => {
  const promise = transcribe(file, { model: "m", language: null }, {}, () => xhr);
  xhr.respond(200, VERBOSE);
  expect((await promise).words).toEqual([]);
});

test("без языка и без ключа", () => {
  void transcribe(file, { model: "m", language: null }, {}, () => xhr);
  expect(xhr.body?.has("language")).toBe(false);
  expect(xhr.headers["Authorization"]).toBeUndefined();
});

test("прогресс и конец загрузки", () => {
  const onUploadProgress = vi.fn<(fraction: number) => void>();
  const onUploaded = vi.fn<() => void>();
  void transcribe(
    file,
    { model: "m", language: null },
    { onUploadProgress, onUploaded },
    () => xhr,
  );
  xhr.upload.dispatchEvent(
    new ProgressEvent("progress", { lengthComputable: true, loaded: 5, total: 10 }),
  );
  expect(onUploadProgress).toHaveBeenCalledWith(0.5);
  xhr.upload.dispatchEvent(new ProgressEvent("load"));
  expect(onUploaded).toHaveBeenCalledOnce();
});

test("413 — ApiError с кодом и сообщением сервера", async () => {
  const promise = transcribe(file, { model: "m", language: null }, {}, () => xhr);
  xhr.respond(
    413,
    '{"error":{"message":"Файл больше лимита 1 МБ","type":"invalid_request_error","param":"file","code":"file_too_large"}}',
  );
  const error = await rejection(promise);
  expect(error.code).toBe("file_too_large");
  expect(error.message).toBe("Файл больше лимита 1 МБ");
});

test("401 — уведомление о неверном ключе", async () => {
  const listener = vi.fn<() => void>();
  const unsubscribe = onUnauthorized(listener);
  const promise = transcribe(file, { model: "m", language: null }, {}, () => xhr);
  xhr.respond(
    401,
    '{"error":{"message":"Неверный ключ","type":"authentication_error","param":null,"code":"invalid_api_key"}}',
  );
  await expect(promise).rejects.toBeInstanceOf(ApiError);
  expect(listener).toHaveBeenCalledOnce();
  unsubscribe();
});

test("ошибка сети", async () => {
  const promise = transcribe(file, { model: "m", language: null }, {}, () => xhr);
  xhr.dispatchEvent(new ProgressEvent("error"));
  expect((await rejection(promise)).status).toBeNull();
});

test("abort через signal", async () => {
  const controller = new AbortController();
  const promise = transcribe(
    file,
    { model: "m", language: null },
    { signal: controller.signal },
    () => xhr,
  );
  controller.abort();
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(xhr.aborted).toBe(true);
  expect(isAbortError(error)).toBe(true);
});
