/** Стрим чата через npm `openai` — тот же SDK, что у внешних клиентов шлюза. */

import OpenAI, { APIConnectionError, APIError, APIUserAbortError } from "openai";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions";
import type { Usage } from "../chat/state";
import { getApiKey, notifyUnauthorized } from "./apiKey";
import { ApiError, networkError } from "./errors";
import { isRecord } from "./json";

export type ChatEvent =
  | { type: "content"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "usage"; usage: Usage };

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function retryAfter(headers: Headers | undefined): number | null {
  const value = headers?.get("retry-after")?.trim();
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

/** Ошибки SDK → `ApiError` с сообщением сервера (у SDK `message` с префиксом статуса). */
function toApiError(error: unknown): unknown {
  if (error instanceof APIUserAbortError) return abortError();
  if (error instanceof APIConnectionError) return networkError();
  if (error instanceof APIError) {
    const body: unknown = error.error;
    const message =
      isRecord(body) && typeof body["message"] === "string" ? body["message"] : error.message;
    const status = typeof error.status === "number" ? error.status : null;
    if (status === 401) notifyUnauthorized();
    // тип headers в d.ts SDK выводится как any — проверяем в рантайме
    const headers: unknown = error.headers;
    return new ApiError(
      message,
      status,
      error.code ?? null,
      retryAfter(headers instanceof Headers ? headers : undefined),
    );
  }
  return error;
}

export async function* streamChat(
  body: ChatCompletionCreateParamsStreaming,
  signal: AbortSignal,
  fetchFn?: typeof fetch,
): AsyncGenerator<ChatEvent> {
  // ключ принадлежит пользователю и уходит только в его же шлюз — поэтому браузер допустим
  const client = new OpenAI({
    baseURL: `${window.location.origin}/v1`,
    apiKey: getApiKey() ?? "none",
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
    ...(fetchFn !== undefined && { fetch: fetchFn }),
  });
  try {
    const stream = await client.chat.completions.create(body, { signal });
    for await (const chunk of stream) {
      for (const choice of chunk.choices) {
        // reasoning_content — расширение шлюза, SDK его не типизирует
        const reasoning: unknown = Reflect.get(choice.delta, "reasoning_content");
        if (typeof reasoning === "string" && reasoning !== "") {
          yield { type: "reasoning", text: reasoning };
        }
        const content = choice.delta.content;
        if (typeof content === "string" && content !== "") yield { type: "content", text: content };
      }
      if (chunk.usage) {
        yield {
          type: "usage",
          usage: {
            prompt_tokens: chunk.usage.prompt_tokens,
            completion_tokens: chunk.usage.completion_tokens,
          },
        };
      }
    }
  } catch (error) {
    throw toApiError(error);
  }
}
