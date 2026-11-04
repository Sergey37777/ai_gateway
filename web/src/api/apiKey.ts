/** API-ключ шлюза: хранится в localStorage, при недоступном хранилище — в памяти вкладки. */

const STORAGE_KEY = "aigw.apiKey";
let memoryKey: string | null = null;
const listeners = new Set<() => void>();

export function getApiKey(): string | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored !== null) return stored;
  } catch {
    // хранилище недоступно (приватный режим, запрет сайта) — только память
  }
  return memoryKey;
}

export function setApiKey(key: string): void {
  memoryKey = key;
  try {
    window.localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // см. getApiKey
  }
}

export function clearApiKey(): void {
  memoryKey = null;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // см. getApiKey
  }
}

/** Заголовок `Authorization`, если ключ задан. */
export function authHeaders(): Record<string, string> {
  const key = getApiKey();
  return key === null ? {} : { Authorization: `Bearer ${key}` };
}

/** Подписка на 401; возвращает отписку. */
export function onUnauthorized(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/** Шлюз ответил 401: ключ сбрасывается, UI спрашивает новый. */
export function notifyUnauthorized(): void {
  clearApiKey();
  for (const callback of listeners) callback();
}
