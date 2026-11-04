/** Ошибки API шлюза (формат OpenAI) и тексты для пользователя. */

import { isRecord } from "./json";

const NETWORK_MESSAGE = "Шлюз недоступен. Проверьте, что сервис запущен";

export class ApiError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  readonly retryAfter: number | null;

  constructor(
    message: string,
    status: number | null,
    code: string | null = null,
    retryAfter: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  return Number(value.trim());
}

/** Ответ с ошибкой → `ApiError`; тело не в формате OpenAI → «Ошибка HTTP <код>». */
export function parseErrorResponse(
  status: number,
  body: string,
  retryAfter: string | null,
): ApiError {
  const retry = parseRetryAfter(retryAfter);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    // не JSON — ниже общий текст
  }
  const error = isRecord(parsed) ? parsed["error"] : undefined;
  if (isRecord(error) && typeof error["message"] === "string") {
    const code = typeof error["code"] === "string" ? error["code"] : null;
    return new ApiError(error["message"], status, code, retry);
  }
  return new ApiError(`Ошибка HTTP ${String(status)}`, status, null, retry);
}

/** Шлюз не ответил (обрыв соединения, сервис не запущен). */
export function networkError(): ApiError {
  return new ApiError(NETWORK_MESSAGE, null);
}

/** Отмена через AbortSignal; `DOMException` не всегда наследует `Error` (jsdom), поэтому по `name`. */
export function isAbortError(e: unknown): boolean {
  return isRecord(e) && e["name"] === "AbortError";
}

/** Текст ошибки для пользователя. */
export function userMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.retryAfter !== null) {
      return `${e.message.replace(/\.$/, "")}. Повторите через ${String(e.retryAfter)} с`;
    }
    return e.message;
  }
  if (e instanceof Error) return e.message;
  return "Неизвестная ошибка";
}
