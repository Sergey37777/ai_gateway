/** Тестовые двойники API документов, диалогов и стрима (в памяти, с семантикой сервера). */

import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions";
import { vi } from "vitest";
import type * as conversationsApi from "../api/conversations";
import type * as documentsApi from "../api/documents";
import type { ChatEvent } from "../api/chat";
import { ApiError } from "../api/errors";
import type { ApiDocument, Conversation, UiConfig } from "../api/types";

export const STAMP = "2026-11-15T10:00:00Z";

export const CONFIG: UiConfig = {
  max_upload_mb: 200,
  max_document_mb: 5,
  auth_required: false,
  default_transcription: "whisper-base",
  models: [
    { id: "whisper-base", kind: "transcription" },
    { id: "gemma4-12b", kind: "chat" },
  ],
  languages: [],
};

export function doc(id: string, overrides: Partial<ApiDocument> = {}): ApiDocument {
  const text = overrides.text ?? "# Спека\n\n## Хранилище\n\nreplace_tail в одной транзакции.\n";
  return {
    id,
    title: "Спека",
    filename: "spec.md",
    format: "markdown",
    chars: text.length,
    revision: 0,
    question_count: 0,
    created_at: STAMP,
    updated_at: STAMP,
    text,
    ...overrides,
  };
}

type Step = { event: ChatEvent } | { end: true } | { error: unknown };

/** Управляемый streamChat: тест сам подаёт события каждого вызова. */
export function fakeStream() {
  const calls: {
    body: ChatCompletionCreateParamsStreaming;
    signal: AbortSignal;
    push: (step: Step) => void;
  }[] = [];
  const streamChat = (body: ChatCompletionCreateParamsStreaming, signal: AbortSignal) => {
    const queue: Step[] = [];
    let wake: (() => void) | null = null;
    const push = (step: Step) => {
      queue.push(step);
      wake?.();
    };
    calls.push({ body, signal, push });
    signal.addEventListener("abort", () => {
      push({ error: new DOMException("Aborted", "AbortError") });
    });
    return (async function* (): AsyncGenerator<ChatEvent> {
      for (;;) {
        const step = queue.shift();
        if (step === undefined) {
          // oxlint-disable-next-line no-await-in-loop -- события подаются тестом по одному
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        if ("end" in step) return;
        if ("error" in step) throw step.error;
        yield step.event;
      }
    })();
  };
  const call = (index: number) => {
    const c = calls[index];
    if (c === undefined) throw new Error(`нет вызова ${String(index)}`);
    return c;
  };
  return { streamChat, calls, call };
}

type DocumentsApi = typeof documentsApi;
type ConversationsApi = typeof conversationsApi;

function missing(what: "document" | "conversation"): ApiError {
  return new ApiError("Не найдено", 404, `${what}_not_found`);
}

/** Документы и вопросы к ним в памяти: revision → 409, нет записи → 404. */
export function fakeApi(initial: ApiDocument[] = [], questions: Conversation[] = []) {
  const documents = new Map(initial.map((d) => [d.id, d]));
  const conversations = new Map(questions.map((c) => [c.id, c]));
  let created = 0;
  const findDoc = (id: string): ApiDocument => {
    const found = documents.get(id);
    if (found === undefined) throw missing("document");
    return found;
  };
  const findConversation = (id: string): Conversation => {
    const found = conversations.get(id);
    if (found === undefined) throw missing("conversation");
    return found;
  };
  const count = (id: string) =>
    [...conversations.values()].filter((c) => c.document_id === id).length;
  const meta = (d: ApiDocument) => {
    const { text: _text, ...rest } = d;
    return { ...rest, question_count: count(d.id) };
  };
  const api = {
    listDocuments: vi.fn<DocumentsApi["listDocuments"]>(() =>
      Promise.resolve({ data: [...documents.values()].toReversed().map(meta), next: null }),
    ),
    getDocument: vi.fn<DocumentsApi["getDocument"]>((id) =>
      Promise.resolve().then(() => ({ ...findDoc(id), question_count: count(id) })),
    ),
    createDocument: vi.fn<DocumentsApi["createDocument"]>((body) => {
      created += 1;
      const document = doc(`doc-${String(created)}`, { ...body, chars: body.text.length });
      documents.set(document.id, document);
      return Promise.resolve(document);
    }),
    renameDocument: vi.fn<DocumentsApi["renameDocument"]>((id, title) =>
      Promise.resolve().then(() => {
        const next = { ...findDoc(id), title, filename: `${title}.md` };
        documents.set(id, next);
        return meta(next);
      }),
    ),
    writeText: vi.fn<DocumentsApi["writeText"]>((id, body) =>
      Promise.resolve().then(() => {
        const current = findDoc(id);
        if (current.revision !== body.revision) {
          throw new ApiError("Документ изменён", 409, "document_conflict");
        }
        const next = {
          ...current,
          text: body.text,
          chars: body.text.length,
          revision: current.revision + 1,
        };
        documents.set(id, next);
        return { revision: next.revision, updated_at: STAMP, chars: next.chars };
      }),
    ),
    deleteDocument: vi.fn<DocumentsApi["deleteDocument"]>((id) =>
      Promise.resolve().then(() => {
        findDoc(id);
        documents.delete(id);
        for (const [cid, c] of conversations) if (c.document_id === id) conversations.delete(cid);
      }),
    ),
    listConversations: vi.fn<ConversationsApi["listConversations"]>((params) =>
      Promise.resolve({
        data: [...conversations.values()]
          .filter((c) => c.document_id === (params.document ?? null))
          .map((c) => ({
            id: c.id,
            title: c.title,
            model: c.settings.model,
            message_count: c.messages.length,
            created_at: c.created_at,
            updated_at: c.updated_at,
            document_id: c.document_id,
            quote: c.quote,
          })),
        next: null,
      }),
    ),
    getConversation: vi.fn<ConversationsApi["getConversation"]>((id) =>
      Promise.resolve().then(() => findConversation(id)),
    ),
    createConversation: vi.fn<ConversationsApi["createConversation"]>((body) => {
      created += 1;
      const conversation: Conversation = {
        title: body.title,
        settings: body.settings,
        messages: body.messages,
        id: `q-${String(created)}`,
        revision: 0,
        message_count: body.messages.length,
        created_at: STAMP,
        updated_at: STAMP,
        document_id: body.document?.id ?? null,
        quote: body.document?.quote ?? null,
        context: body.document?.context ?? null,
      };
      conversations.set(conversation.id, conversation);
      return Promise.resolve(conversation);
    }),
    replaceTail: vi.fn<ConversationsApi["replaceTail"]>((id, from, body) =>
      Promise.resolve().then(() => {
        const current = findConversation(id);
        if (current.revision !== body.revision) {
          throw new ApiError("Диалог изменён", 409, "conversation_conflict");
        }
        const messages = [...current.messages.slice(0, from), ...body.messages];
        const next = { ...current, messages, revision: current.revision + 1 };
        conversations.set(id, next);
        return { revision: next.revision, updated_at: STAMP, message_count: messages.length };
      }),
    ),
    patchConversation: vi.fn<ConversationsApi["patchConversation"]>((id, body) =>
      Promise.resolve().then(() => {
        const next = { ...findConversation(id), ...body };
        conversations.set(id, next);
        return next;
      }),
    ),
    deleteConversation: vi.fn<ConversationsApi["deleteConversation"]>((id) =>
      Promise.resolve().then(() => {
        findConversation(id);
        conversations.delete(id);
      }),
    ),
  };
  return { api, documents, conversations };
}

export function question(id: string, documentId: string, quote: string): Conversation {
  return {
    id,
    title: quote,
    settings: {
      model: "gemma4-12b",
      system_prompt: "",
      temperature: null,
      max_tokens: null,
      reasoning_effort: null,
    },
    revision: 1,
    message_count: 2,
    created_at: STAMP,
    updated_at: STAMP,
    document_id: documentId,
    quote,
    context: "контекст",
    messages: [
      { role: "user", text: "Что это значит?", images: [] },
      {
        role: "assistant",
        text: "Это блокировка строки.",
        reasoning: "",
        status: "done",
        error: null,
        usage: null,
        model: "gemma4-12b",
      },
    ],
  };
}
