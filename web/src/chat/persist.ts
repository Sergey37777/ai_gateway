/**
 * Сохранение диалога: перевод сообщений UI ↔ API и план записи «замены хвоста».
 *
 * UI помнит снимок последнего сохранённого (`saved`); `planWrite` сравнивает его с текущим
 * состоянием и отвечает, с какой позиции и что записать (спецификация этапа 5, §7.4).
 */

import type { ApiChatSettings, ApiMessage } from "../api/types";
import type { ChatSettings as RequestSettings } from "./request";
import type { SettingsDraft } from "./settings";
import type { ChatMessage } from "./state";

const TITLE_LENGTH = 60;

/** Сообщение для API; стримящийся ответ не сохраняется — `null`. */
export function toApiMessage(message: ChatMessage): ApiMessage | null {
  if (message.role === "user") {
    return {
      role: "user",
      text: message.text,
      images: message.images.map((image) => ({ name: image.name, data_url: image.dataUrl })),
    };
  }
  if (message.status === "streaming") return null;
  return {
    role: "assistant",
    text: message.content,
    reasoning: message.reasoning,
    status: message.status,
    error: message.error,
    usage: message.usage,
    model: message.model,
  };
}

/** Сохранённые сообщения → сообщения UI с id `firstId`, `firstId + 1`, … */
export function fromApiMessages(list: ApiMessage[], firstId: number): ChatMessage[] {
  return list.map((message, index): ChatMessage => {
    const id = firstId + index;
    if (message.role === "user") {
      return {
        id,
        role: "user",
        text: message.text,
        images: message.images.map((image) => ({ name: image.name, dataUrl: image.data_url })),
      };
    }
    return {
      id,
      role: "assistant",
      content: message.text,
      reasoning: message.reasoning,
      status: message.status,
      usage: message.usage,
      error: message.error,
      model: message.model,
    };
  });
}

/** То, что можно сохранить: всё, кроме стримящегося ответа. */
export function persistable(messages: ChatMessage[]): ApiMessage[] {
  return messages.map(toApiMessage).filter((m): m is ApiMessage => m !== null);
}

function same(a: ApiMessage, b: ApiMessage): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function firstDifference(saved: ApiMessage[], next: ApiMessage[]): number {
  let index = 0;
  while (index < saved.length && index < next.length) {
    const left = saved[index];
    const right = next[index];
    if (left === undefined || right === undefined || !same(left, right)) break;
    index += 1;
  }
  return index;
}

export interface WritePlan {
  from: number;
  messages: ApiMessage[];
}

/**
 * Что записать, чтобы сохранённое совпало с текущим; `null` — писать нечего (или пока рано).
 *
 * Запись, которая только удаляет, откладывается до конца стрима: при перегенерации старый
 * ответ остаётся в БД, пока новый не готов.
 */
export function planWrite(saved: ApiMessage[], current: ChatMessage[]): WritePlan | null {
  const next = persistable(current);
  const from = firstDifference(saved, next);
  if (from === saved.length && from === next.length) return null;
  const messages = next.slice(from);
  const streaming = current.some((m) => m.role === "assistant" && m.status === "streaming");
  if (messages.length === 0 && streaming) return null;
  return { from, messages };
}

/** Есть ли расхождение с сохранённым (без отсрочки на время стрима). */
export function hasUnsaved(saved: ApiMessage[], current: ChatMessage[]): boolean {
  const next = persistable(current);
  const from = firstDifference(saved, next);
  return from !== saved.length || from !== next.length;
}

/** Название диалога из первого вопроса: первая непустая строка, ≤ 60 символов. */
export function titleFrom(text: string, hasImages: boolean): string {
  const line =
    text
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .find((l) => l !== "") ?? "";
  if (line === "") return hasImages ? "Картинка" : "Новый диалог";
  // по кодовым точкам: эмодзи не режется посередине
  const chars = Array.from(line);
  return chars.length > TITLE_LENGTH ? `${chars.slice(0, TITLE_LENGTH - 1).join("")}…` : line;
}

export function toApiSettings(settings: RequestSettings): ApiChatSettings {
  return {
    model: settings.model,
    system_prompt: settings.systemPrompt,
    temperature: settings.temperature,
    max_tokens: settings.maxTokens,
    reasoning_effort: settings.reasoningEffort,
  };
}

/** Настройки диалога → модель и черновик полей формы. */
export function fromApiSettings(settings: ApiChatSettings): {
  model: string;
  draft: SettingsDraft;
} {
  return {
    model: settings.model,
    draft: {
      systemPrompt: settings.system_prompt,
      temperature: settings.temperature === null ? "" : String(settings.temperature),
      maxTokens: settings.max_tokens === null ? "" : String(settings.max_tokens),
      reasoningEffort: settings.reasoning_effort ?? "",
    },
  };
}
