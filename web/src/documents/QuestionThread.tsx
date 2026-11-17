import { useEffect, useRef, useState, type FormEvent } from "react";
import type { streamChat as defaultStreamChat } from "../api/chat";
import type * as conversationsApi from "../api/conversations";
import { ApiError, userMessage } from "../api/errors";
import type { ApiChatSettings } from "../api/types";
import { ErrorBanner } from "../components/ErrorBanner";
import { Composer } from "../chat/Composer";
import { MessageList } from "../chat/MessageList";
import { fromApiMessages, titleFrom, toApiSettings } from "../chat/persist";
import type { ChatSettings as RequestSettings } from "../chat/request";
import { parseMaxTokens, parseTemperature } from "../chat/settings";
import { readStoredSettings } from "../chat/storedSettings";
import { useChatSession } from "../chat/useChatSession";
import { useConversationSaver } from "../chat/useConversationSaver";
import { EditableAnswer } from "./EditableAnswer";
import { buildQuestionRequest } from "./request";

export interface QuestionDeps {
  streamChat: typeof defaultStreamChat;
  listConversations: typeof conversationsApi.listConversations;
  getConversation: typeof conversationsApi.getConversation;
  createConversation: typeof conversationsApi.createConversation;
  replaceTail: typeof conversationsApi.replaceTail;
  patchConversation: typeof conversationsApi.patchConversation;
  deleteConversation: typeof conversationsApi.deleteConversation;
}

export interface Draft {
  key: number;
  quote: string;
  context: string;
}

interface Props {
  /** `text` — текущий текст документа: по нему проверяются и применяются правки модели. */
  document: { id: string; title: string; text: string };
  /** Сохранённый вопрос; `null` — новый из черновика. */
  conversationId: string | null;
  draft: Draft | null;
  models: string[];
  deps: QuestionDeps;
  onCreated: (id: string) => void;
  onDeleted: () => void;
  onBack: () => void;
  onQuoteClick: (quote: string) => void;
  onBusyChange: (busy: boolean) => void;
  /** Применить правку модели: новый текст документа и смещение изменённого места. */
  onApplyEdit: (text: string, at: number) => void;
  /** `false` — документ сейчас нельзя менять (конфликт). */
  canEdit: boolean;
}

const DEFAULT_QUESTION = "Что это значит?";

type Loading = { kind: "ready" } | { kind: "loading" } | { kind: "error"; message: string };

/** Настройки вопроса: модель — из панели, остальное — последние настройки чата. */
function initialSettings(models: string[]): RequestSettings {
  const stored = readStoredSettings();
  const model = stored !== null && models.includes(stored.model) ? stored.model : (models[0] ?? "");
  return {
    model,
    // системный промпт вопроса — свой (documentSystemPrompt), промпт чата не используется
    systemPrompt: "",
    temperature: parseTemperature(stored?.draft.temperature ?? ""),
    maxTokens: parseMaxTokens(stored?.draft.maxTokens ?? ""),
    reasoningEffort:
      stored === null || stored.draft.reasoningEffort === "" ? null : stored.draft.reasoningEffort,
  };
}

/** Один вопрос к документу: цитата, первый вопрос (черновик), дальше — диалог как в чате. */
export function QuestionThread({
  document,
  conversationId,
  draft,
  models,
  deps,
  onCreated,
  onDeleted,
  onBack,
  onQuoteClick,
  onBusyChange,
  onApplyEdit,
  canEdit,
}: Props) {
  const [quote, setQuote] = useState(draft?.quote ?? "");
  const [context, setContext] = useState(draft?.context ?? "");
  const [question, setQuestion] = useState(DEFAULT_QUESTION);
  const [loading, setLoading] = useState<Loading>(
    conversationId === null ? { kind: "ready" } : { kind: "loading" },
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [initial] = useState(() => initialSettings(models));
  const settingsRef = useRef<RequestSettings>(initial);
  const [model, setModel] = useState(initial.model);
  const quoteRef = useRef({ quote, context });
  useEffect(() => {
    quoteRef.current = { quote, context };
  });

  const apiSettings = (): ApiChatSettings => toApiSettings(settingsRef.current);

  const saver = useConversationSaver({
    api: deps,
    onCreated: (conversation) => {
      onCreated(conversation.id);
    },
    onSaved: () => undefined,
    createExtra: () => ({
      title: titleFrom(quoteRef.current.quote, false),
      document: { id: document.id, ...quoteRef.current },
    }),
  });

  const session = useChatSession({
    streamChat: deps.streamChat,
    buildBody: (history, settings) =>
      buildQuestionRequest(history, settings, { title: document.title, ...quoteRef.current }),
    settings: () => settingsRef.current,
    onApply: (next, action) => {
      if (action.type !== "delta" && action.type !== "usage" && action.type !== "started") {
        saver.sync(next.messages, apiSettings());
      }
    },
  });
  const { state, run, stop, busy } = session;
  const conflict = saver.status.kind === "conflict";

  useEffect(() => {
    onBusyChange(busy || saver.unsaved);
  }, [busy, saver.unsaved, onBusyChange]);

  // уход с вопроса во время стрима — как «Стоп»: обрезанный ответ сохраняется
  const stopRef = useRef(stop);
  useEffect(() => {
    stopRef.current = stop;
  });
  useEffect(
    () => () => {
      stopRef.current();
    },
    [],
  );

  const load = (id: string) => {
    setLoading({ kind: "loading" });
    deps.getConversation(id).then(
      (conversation) => {
        saver.reset(conversation);
        setQuote(conversation.quote ?? "");
        setContext(conversation.context ?? "");
        quoteRef.current = { quote: conversation.quote ?? "", context: conversation.context ?? "" };
        const saved = conversation.settings.model;
        const nextModel = models.includes(saved) ? saved : (models[0] ?? saved);
        settingsRef.current = { ...settingsRef.current, model: nextModel };
        setModel(nextModel);
        session.apply({ type: "load", messages: fromApiMessages(conversation.messages, 0) });
        setLoading({ kind: "ready" });
      },
      (error: unknown) => {
        setLoading({
          kind: "error",
          message:
            error instanceof ApiError && error.status === 404
              ? "Вопрос не найден — возможно, его удалили"
              : userMessage(error),
        });
      },
    );
  };

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  const initialId = useRef(conversationId);
  useEffect(() => {
    if (initialId.current !== null) loadRef.current(initialId.current);
  }, []);

  const changeModel = (value: string) => {
    settingsRef.current = { ...settingsRef.current, model: value };
    setModel(value);
    saver.syncSettings(apiSettings());
  };

  const remove = () => {
    const id = saver.conversationId;
    if (id === null) {
      onBack();
      return;
    }
    if (!window.confirm("Удалить вопрос?")) return;
    session.abort();
    deps.deleteConversation(id).then(onDeleted, (error: unknown) => {
      setActionError(userMessage(error));
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (text === "" || models.length === 0) return;
    run({ type: "send", text, images: [] });
  };

  const started = state.messages.length > 0;
  const status = saver.status;

  return (
    <div className="doc-thread">
      <div className="doc-thread-bar">
        <button type="button" className="button-secondary" onClick={onBack}>
          ← Вопросы
        </button>
        <button
          type="button"
          className="button-secondary button-quiet-danger"
          aria-label="Удалить вопрос"
          onClick={remove}
        >
          Удалить
        </button>
      </div>

      {loading.kind === "loading" && <p className="muted">Загрузка…</p>}
      {loading.kind === "error" && (
        <ErrorBanner
          message={loading.message}
          {...(conversationId !== null && {
            onRetry: () => {
              load(conversationId);
            },
          })}
        />
      )}
      {actionError !== null && <ErrorBanner message={actionError} />}

      {loading.kind === "ready" && quote !== "" && !started && (
        <form className="doc-draft" aria-label="Новый вопрос" onSubmit={submit}>
          <button
            type="button"
            className="doc-quote"
            onClick={() => {
              onQuoteClick(quote);
            }}
          >
            «{quote}»
          </button>
          <textarea
            aria-label="Вопрос"
            value={question}
            rows={3}
            autoFocus
            onFocus={(event) => {
              event.target.select();
            }}
            onChange={(event) => {
              setQuestion(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="doc-draft-actions">
            {models.length > 1 ? (
              <select
                aria-label="Модель"
                value={model}
                onChange={(event) => {
                  changeModel(event.target.value);
                }}
              >
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <span className="muted small">{model}</span>
            )}
            <button type="submit" disabled={question.trim() === "" || models.length === 0}>
              Спросить
            </button>
          </div>
        </form>
      )}

      {loading.kind === "ready" && started && (
        <>
          <button
            type="button"
            className="doc-quote"
            title="Показать в документе"
            onClick={() => {
              onQuoteClick(quote);
            }}
          >
            «{quote}»
          </button>
          <MessageList
            messages={state.messages}
            busy={busy || conflict}
            onEdit={(id, text) => {
              run({ type: "edit", id, text });
            }}
            onRegenerate={() => {
              run({ type: "regenerate" });
            }}
            renderAssistant={(message) => (
              <EditableAnswer
                content={message.content}
                doc={document.text}
                canApply={canEdit}
                onApply={onApplyEdit}
              />
            )}
          />
          {status.kind === "error" && (
            <div className="chat-save-error" role="status">
              <span>Не сохранено: {status.message}</span>
              <button type="button" className="button-secondary" onClick={saver.retry}>
                Повторить сохранение
              </button>
            </div>
          )}
          {conflict && (
            <div className="chat-save-error" role="status">
              <span>Вопрос изменён в другой вкладке</span>
              {saver.conversationId !== null && (
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => {
                    const id = saver.conversationId;
                    if (id !== null) load(id);
                  }}
                >
                  Загрузить заново
                </button>
              )}
            </div>
          )}
          <Composer
            disabled={conflict}
            streaming={busy}
            onSend={(text, images) => {
              run({ type: "send", text, images });
            }}
            onStop={stop}
          />
        </>
      )}
    </div>
  );
}
