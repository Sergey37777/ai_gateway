/** Черновик настроек чата из полей формы и его разбор. */

import type { ReasoningEffort } from "./request";

export interface SettingsDraft {
  systemPrompt: string;
  temperature: string;
  maxTokens: string;
  reasoningEffort: ReasoningEffort | "";
}

export const EMPTY_SETTINGS: SettingsDraft = {
  systemPrompt: "",
  temperature: "",
  maxTokens: "",
  reasoningEffort: "",
};

/** Строка поля → число в диапазоне или `null` (пусто / неверно — не отправляется). */
export function parseTemperature(value: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value.replace(",", "."));
  return Number.isFinite(n) && n >= 0 && n <= 2 ? n : null;
}

export function parseMaxTokens(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return n >= 1 ? n : null;
}
