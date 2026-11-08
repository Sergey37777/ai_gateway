/** Клиент диалогов чата `/api/conversations…` (собственный API шлюза). */

import { ApiError } from "./errors";
import { jsonInit, request } from "./http";
import { isRecord } from "./json";
import type {
  ApiAssistantMessage,
  ApiChatSettings,
  ApiMessage,
  ApiUsage,
  ApiUserMessage,
  Conversation,
  ConversationItem,
  ConversationMeta,
  ConversationPage,
  TailResult,
} from "./types";

const BASE = "/api/conversations";
const EFFORTS = ["none", "low", "medium", "high"] as const;
const STATUSES = ["done", "stopped", "error"] as const;

function numberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function stringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function parseSettings(value: unknown): ApiChatSettings | null {
  if (!isRecord(value)) return null;
  const { model, system_prompt: prompt, temperature, max_tokens: maxTokens } = value;
  const effort = EFFORTS.find((e) => e === value["reasoning_effort"]) ?? null;
  if (value["reasoning_effort"] !== null && effort === null) return null;
  if (
    typeof model !== "string" ||
    typeof prompt !== "string" ||
    !numberOrNull(temperature) ||
    !numberOrNull(maxTokens)
  ) {
    return null;
  }
  return {
    model,
    system_prompt: prompt,
    temperature,
    max_tokens: maxTokens,
    reasoning_effort: effort,
  };
}

function parseUsage(value: unknown): ApiUsage | null | undefined {
  if (value === null) return null;
  if (
    isRecord(value) &&
    typeof value["prompt_tokens"] === "number" &&
    typeof value["completion_tokens"] === "number"
  ) {
    return { prompt_tokens: value["prompt_tokens"], completion_tokens: value["completion_tokens"] };
  }
  return undefined;
}

function parseUser(value: Record<string, unknown>): ApiUserMessage | null {
  const { text, images } = value;
  if (typeof text !== "string" || !Array.isArray(images)) return null;
  const parsed: ApiUserMessage["images"] = [];
  for (const image of images) {
    if (!isRecord(image)) return null;
    const { name, data_url: dataUrl } = image;
    if (typeof name !== "string" || typeof dataUrl !== "string") return null;
    parsed.push({ name, data_url: dataUrl });
  }
  return { role: "user", text, images: parsed };
}

function parseAssistant(value: Record<string, unknown>): ApiAssistantMessage | null {
  const { text, reasoning, error, model } = value;
  const status = STATUSES.find((s) => s === value["status"]);
  const usage = parseUsage(value["usage"]);
  if (
    typeof text !== "string" ||
    typeof reasoning !== "string" ||
    status === undefined ||
    !stringOrNull(error) ||
    !stringOrNull(model) ||
    usage === undefined
  ) {
    return null;
  }
  return { role: "assistant", text, reasoning, status, error, usage, model };
}

export function parseMessage(value: unknown): ApiMessage | null {
  if (!isRecord(value)) return null;
  if (value["role"] === "user") return parseUser(value);
  if (value["role"] === "assistant") return parseAssistant(value);
  return null;
}

export function parseMeta(value: unknown): ConversationMeta | null {
  if (!isRecord(value)) return null;
  const {
    id,
    title,
    revision,
    message_count: count,
    created_at: created,
    updated_at: updated,
  } = value;
  const settings = parseSettings(value["settings"]);
  if (
    typeof id !== "string" ||
    typeof title !== "string" ||
    typeof revision !== "number" ||
    typeof count !== "number" ||
    typeof created !== "string" ||
    typeof updated !== "string" ||
    settings === null
  ) {
    return null;
  }
  return {
    id,
    title,
    settings,
    revision,
    message_count: count,
    created_at: created,
    updated_at: updated,
  };
}

export function parseConversation(value: unknown): Conversation | null {
  const meta = parseMeta(value);
  if (meta === null || !isRecord(value) || !Array.isArray(value["messages"])) return null;
  const messages: ApiMessage[] = [];
  for (const item of value["messages"]) {
    const message = parseMessage(item);
    if (message === null) return null;
    messages.push(message);
  }
  return { ...meta, messages };
}

export function parseItem(value: unknown): ConversationItem | null {
  if (!isRecord(value)) return null;
  const {
    id,
    title,
    model,
    message_count: count,
    created_at: created,
    updated_at: updated,
  } = value;
  if (
    typeof id !== "string" ||
    typeof title !== "string" ||
    typeof model !== "string" ||
    typeof count !== "number" ||
    typeof created !== "string" ||
    typeof updated !== "string"
  ) {
    return null;
  }
  const item: ConversationItem = {
    id,
    title,
    model,
    message_count: count,
    created_at: created,
    updated_at: updated,
  };
  if (typeof value["snippet"] === "string") item.snippet = value["snippet"];
  return item;
}

function invalid(): ApiError {
  return new ApiError("Некорректный ответ сервера", null);
}

async function json(url: string, init?: RequestInit): Promise<unknown> {
  return JSON.parse(await (await request(url, init)).text());
}

function path(id: string): string {
  return `${BASE}/${encodeURIComponent(id)}`;
}

export async function listConversations(
  params: { q?: string; before?: string },
  signal?: AbortSignal,
): Promise<ConversationPage> {
  const query = new URLSearchParams();
  if (params.q !== undefined && params.q !== "") query.set("q", params.q);
  if (params.before !== undefined) query.set("before", params.before);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const data = await json(`${BASE}${suffix}`, signal ? { signal } : {});
  if (!isRecord(data) || !Array.isArray(data["data"])) throw invalid();
  const next = data["next"];
  return {
    data: data["data"].map(parseItem).filter((item): item is ConversationItem => item !== null),
    next: typeof next === "string" ? next : null,
  };
}

export async function getConversation(id: string, signal?: AbortSignal): Promise<Conversation> {
  const conversation = parseConversation(await json(path(id), signal ? { signal } : {}));
  if (conversation === null) throw invalid();
  return conversation;
}

export async function createConversation(body: {
  title: string;
  settings: ApiChatSettings;
  messages: ApiMessage[];
}): Promise<Conversation> {
  const conversation = parseConversation(await json(BASE, jsonInit("POST", body)));
  if (conversation === null) throw invalid();
  return conversation;
}

export async function patchConversation(
  id: string,
  body: { title?: string; settings?: ApiChatSettings },
): Promise<ConversationMeta> {
  const meta = parseMeta(await json(path(id), jsonInit("PATCH", body)));
  if (meta === null) throw invalid();
  return meta;
}

/** Замена сообщений с позиции `from`; `revision` — последний известный (иначе 409). */
export async function replaceTail(
  id: string,
  from: number,
  body: { revision: number; messages: ApiMessage[] },
): Promise<TailResult> {
  const data = await json(`${path(id)}/messages?from=${String(from)}`, jsonInit("PUT", body));
  if (
    !isRecord(data) ||
    typeof data["revision"] !== "number" ||
    typeof data["updated_at"] !== "string" ||
    typeof data["message_count"] !== "number"
  ) {
    throw invalid();
  }
  return {
    revision: data["revision"],
    updated_at: data["updated_at"],
    message_count: data["message_count"],
  };
}

export async function deleteConversation(id: string): Promise<void> {
  await request(path(id), { method: "DELETE" });
}
