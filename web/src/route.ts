/** Маршрут UI в хэше адреса: вкладка, открытая запись истории, диалог чата, документ. */

export type Tab = "transcribe" | "history" | "chat" | "documents";

export interface Route {
  tab: Tab;
  /** `#history/<id>` — открытая запись. */
  recordId: string | null;
  /** `#chat/<id>` — сохранённый диалог; `#chat` — новый. */
  conversationId: string | null;
  /** `#documents/<id>` — открытый документ. */
  documentId: string | null;
  /** `#documents/<id>/<questionId>` — открытый вопрос к документу. */
  questionId: string | null;
}

const EMPTY = { recordId: null, conversationId: null, documentId: null, questionId: null };

/** Id после префикса `#<tab>/`; пусто — `null`. */
function suffix(hash: string, prefix: string): string | null {
  if (!hash.startsWith(prefix)) return null;
  const id = decodeURIComponent(hash.slice(prefix.length));
  return id === "" ? null : id;
}

function part(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  return decodeURIComponent(value);
}

export function parseRoute(hash: string): Route {
  if (hash === "#chat" || hash.startsWith("#chat/")) {
    return { ...EMPTY, tab: "chat", conversationId: suffix(hash, "#chat/") };
  }
  if (hash === "#history" || hash.startsWith("#history/")) {
    return { ...EMPTY, tab: "history", recordId: suffix(hash, "#history/") };
  }
  if (hash === "#documents" || hash.startsWith("#documents/")) {
    const [documentId, questionId] = hash.slice("#documents/".length).split("/");
    const doc = hash === "#documents" ? null : part(documentId);
    return {
      ...EMPTY,
      tab: "documents",
      documentId: doc,
      questionId: doc === null ? null : part(questionId),
    };
  }
  return { ...EMPTY, tab: "transcribe" };
}

export function recordHash(id: string): string {
  return `#history/${encodeURIComponent(id)}`;
}

export function conversationHash(id: string): string {
  return `#chat/${encodeURIComponent(id)}`;
}

export function documentHash(id: string, questionId: string | null = null): string {
  const base = `#documents/${encodeURIComponent(id)}`;
  return questionId === null ? base : `${base}/${encodeURIComponent(questionId)}`;
}
