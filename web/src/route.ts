/** Маршрут UI в хэше адреса: вкладка и открытая запись истории. */

export type Tab = "transcribe" | "history" | "chat";

export interface Route {
  tab: Tab;
  /** `#history/<id>` — открытая запись. */
  recordId: string | null;
}

export function parseRoute(hash: string): Route {
  if (hash === "#chat") return { tab: "chat", recordId: null };
  if (hash === "#history" || hash.startsWith("#history/")) {
    const id = decodeURIComponent(hash.slice("#history/".length));
    return { tab: "history", recordId: hash.startsWith("#history/") && id !== "" ? id : null };
  }
  return { tab: "transcribe", recordId: null };
}

export function recordHash(id: string): string {
  return `#history/${encodeURIComponent(id)}`;
}
