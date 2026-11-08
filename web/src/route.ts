/** Маршрут UI в хэше адреса: вкладка, открытая запись истории и открытый диалог чата. */

export type Tab = "transcribe" | "history" | "chat";

export interface Route {
  tab: Tab;
  /** `#history/<id>` — открытая запись. */
  recordId: string | null;
  /** `#chat/<id>` — сохранённый диалог; `#chat` — новый. */
  conversationId: string | null;
}

/** Id после префикса `#<tab>/`; пусто — `null`. */
function suffix(hash: string, prefix: string): string | null {
  if (!hash.startsWith(prefix)) return null;
  const id = decodeURIComponent(hash.slice(prefix.length));
  return id === "" ? null : id;
}

export function parseRoute(hash: string): Route {
  if (hash === "#chat" || hash.startsWith("#chat/")) {
    return { tab: "chat", recordId: null, conversationId: suffix(hash, "#chat/") };
  }
  if (hash === "#history" || hash.startsWith("#history/")) {
    return { tab: "history", recordId: suffix(hash, "#history/"), conversationId: null };
  }
  return { tab: "transcribe", recordId: null, conversationId: null };
}

export function recordHash(id: string): string {
  return `#history/${encodeURIComponent(id)}`;
}

export function conversationHash(id: string): string {
  return `#chat/${encodeURIComponent(id)}`;
}
