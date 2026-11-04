import { expect, test } from "vitest";
import { ApiError, isAbortError, networkError, parseErrorResponse, userMessage } from "./errors";

test("тело OpenAI", () => {
  const e = parseErrorResponse(
    503,
    '{"error":{"message":"Нет памяти","type":"server_error","param":null,"code":"model_unavailable"}}',
    "30",
  );
  expect([e.status, e.code, e.message, e.retryAfter]).toEqual([
    503,
    "model_unavailable",
    "Нет памяти",
    30,
  ]);
  expect(userMessage(e)).toBe("Нет памяти. Повторите через 30 с");
});

test("точка в конце сообщения не удваивается", () => {
  const e = parseErrorResponse(
    503,
    '{"error":{"message":"Нет памяти.","type":"server_error","param":null,"code":"model_unavailable"}}',
    "30",
  );
  expect(userMessage(e)).toBe("Нет памяти. Повторите через 30 с");
});

test("тело не OpenAI", () => {
  const e = parseErrorResponse(502, "<html>", null);
  expect(e.code).toBeNull();
  expect(userMessage(e)).toBe("Ошибка HTTP 502");
});

test("413 — сообщение сервера", () => {
  const e = parseErrorResponse(
    413,
    '{"error":{"message":"Файл больше лимита 200 МБ","type":"invalid_request_error","param":"file","code":"file_too_large"}}',
    null,
  );
  expect(e.retryAfter).toBeNull();
  expect(userMessage(e)).toBe("Файл больше лимита 200 МБ");
});

test("сеть", () => {
  const e = networkError();
  expect(e).toBeInstanceOf(ApiError);
  expect(e.status).toBeNull();
  expect(userMessage(e)).toBe("Шлюз недоступен. Проверьте, что сервис запущен");
});

test("неверный Retry-After игнорируется", () => {
  expect(parseErrorResponse(503, "{}", "скоро").retryAfter).toBeNull();
});

test("isAbortError", () => {
  expect(isAbortError(new DOMException("Aborted", "AbortError"))).toBe(true);
  expect(isAbortError(new Error("x"))).toBe(false);
});

test("userMessage для обычной ошибки и не-ошибки", () => {
  expect(userMessage(new Error("сломалось"))).toBe("сломалось");
  expect(userMessage(42)).toBe("Неизвестная ошибка");
});
