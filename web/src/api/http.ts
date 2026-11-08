/** fetch собственного API шлюза: ключ, ошибки в формате OpenAI → `ApiError`, сеть → понятный текст. */

import { authHeaders, notifyUnauthorized } from "./apiKey";
import { networkError, parseErrorResponse } from "./errors";
import { isRecord } from "./json";

/** fetch с ключом; ошибки — `ApiError` (401 — запрос ключа), сеть — понятный текст. */
export async function request(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(authHeaders())) headers.set(name, value);
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch (error) {
    if (isRecord(error) && error["name"] === "AbortError") throw error;
    throw networkError();
  }
  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized();
    throw parseErrorResponse(
      response.status,
      await response.text(),
      response.headers.get("Retry-After"),
    );
  }
  return response;
}

/** Тело JSON-запроса. */
export function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
