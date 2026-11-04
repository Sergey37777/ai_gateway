import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearApiKey, onUnauthorized, setApiKey } from "./apiKey";
import { ApiError, isAbortError } from "./errors";
import { xhrUpload, type UploadHooks, type XhrLike } from "./xhr";

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

function upload(hooks: UploadHooks, form: FormData = new FormData()): Promise<string> {
  return xhrUpload(
    "/api/x",
    form,
    (text) => text.toUpperCase(),
    hooks,
    () => xhr,
  );
}

test("POST формы, ключ и разбор ответа", async () => {
  setApiKey("k");
  const form = new FormData();
  form.append("model", "m");
  const promise = upload({}, form);
  expect([xhr.method, xhr.url]).toEqual(["POST", "/api/x"]);
  expect(xhr.headers["Authorization"]).toBe("Bearer k");
  expect(xhr.body).toBe(form);
  xhr.respond(202, "ok");
  expect(await promise).toBe("OK");
});

test("без ключа — без заголовка", () => {
  void upload({});
  expect(xhr.headers["Authorization"]).toBeUndefined();
});

test("прогресс и конец загрузки", () => {
  const onUploadProgress = vi.fn<(fraction: number) => void>();
  const onUploaded = vi.fn<() => void>();
  void upload({ onUploadProgress, onUploaded });
  xhr.upload.dispatchEvent(
    new ProgressEvent("progress", { lengthComputable: true, loaded: 5, total: 10 }),
  );
  expect(onUploadProgress).toHaveBeenCalledWith(0.5);
  xhr.upload.dispatchEvent(new ProgressEvent("load"));
  expect(onUploaded).toHaveBeenCalledOnce();
});

test("413 — ApiError с кодом и сообщением сервера", async () => {
  const promise = upload({});
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
  const promise = upload({});
  xhr.respond(
    401,
    '{"error":{"message":"Неверный ключ","type":"authentication_error","param":null,"code":"invalid_api_key"}}',
  );
  await expect(promise).rejects.toBeInstanceOf(ApiError);
  expect(listener).toHaveBeenCalledOnce();
  unsubscribe();
});

test("ошибка сети", async () => {
  const promise = upload({});
  xhr.dispatchEvent(new ProgressEvent("error"));
  expect((await rejection(promise)).status).toBeNull();
});

test("abort через signal", async () => {
  const controller = new AbortController();
  const promise = upload({ signal: controller.signal });
  controller.abort();
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(xhr.aborted).toBe(true);
  expect(isAbortError(error)).toBe(true);
});
