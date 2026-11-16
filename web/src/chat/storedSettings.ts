/** Последние настройки чата в `localStorage` — удобство одного браузера, не источник истины. */

import { parseSettings } from "../api/conversations";
import type { ApiChatSettings } from "../api/types";
import { fromApiSettings } from "./persist";
import type { SettingsDraft } from "./settings";

const SETTINGS_KEY = "aigw.chat.settings";

/** Хранилище может быть недоступно (приватный режим) — тогда `null`. */
export function readStoredSettings(): { model: string; draft: SettingsDraft } | null {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    const parsed = parseSettings(value);
    return parsed === null ? null : fromApiSettings(parsed);
  } catch {
    return null;
  }
}

export function storeSettings(settings: ApiChatSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // приватный режим или запрет хранилища — настройки просто не запомнятся
  }
}
