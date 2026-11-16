import { useCallback, useEffect, useRef, useState } from "react";
import { userMessage } from "../api/errors";
import type { ConversationItem } from "../api/types";
import { ErrorBanner } from "../components/ErrorBanner";
import { formatDate } from "../history/format";
import { QuestionThread, type Draft, type QuestionDeps } from "./QuestionThread";

interface Props {
  document: { id: string; title: string; text: string };
  /** Новый черновик из выделения; смена `key` открывает его. */
  draft: Draft | null;
  /** Вопрос из адреса `#documents/<id>/<questionId>`. */
  questionId: string | null;
  models: string[];
  deps: QuestionDeps;
  onClose: () => void;
  /** Открыть вопрос (или вернуться к списку — `null`): меняет адрес. */
  onOpen: (questionId: string | null) => void;
  /** Новый вопрос сохранён: адрес без перезагрузки панели. */
  onCreated: (questionId: string) => void;
  onCountChange: (delta: number) => void;
  onQuoteClick: (quote: string) => void;
  onBusyChange: (busy: boolean) => void;
}

interface Open {
  key: string;
  conversationId: string | null;
  draft: Draft | null;
}

function fromQuestion(id: string): Open {
  return { key: id, conversationId: id, draft: null };
}

function fromDraft(draft: Draft): Open {
  return { key: `draft-${String(draft.key)}`, conversationId: null, draft };
}

/** Панель вопросов документа: список вопросов или открытый вопрос (диалог с цитатой). */
export function QuestionPanel({
  document,
  draft,
  questionId,
  models,
  deps,
  onClose,
  onOpen,
  onCreated,
  onCountChange,
  onQuoteClick,
  onBusyChange,
}: Props) {
  const [open, setOpen] = useState<Open | null>(() =>
    draft !== null ? fromDraft(draft) : questionId !== null ? fromQuestion(questionId) : null,
  );
  const [items, setItems] = useState<ConversationItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => new Date());
  const requestRef = useRef(0);

  // адрес сменился извне (клик по вопросу, «назад» браузера) — открыть его
  const [seenQuestion, setSeenQuestion] = useState(questionId);
  if (questionId !== seenQuestion) {
    setSeenQuestion(questionId);
    if (questionId === null) {
      if (open?.conversationId != null) setOpen(null);
    } else if (questionId !== open?.conversationId) {
      setOpen(fromQuestion(questionId));
    }
  }
  const [seenDraft, setSeenDraft] = useState(draft?.key ?? null);
  if (draft !== null && draft.key !== seenDraft) {
    setSeenDraft(draft.key);
    setOpen(fromDraft(draft));
  }

  const { listConversations } = deps;
  const load = useCallback(
    (before?: string) => {
      const request = ++requestRef.current;
      listConversations(
        before === undefined ? { document: document.id } : { document: document.id, before },
      ).then(
        (page) => {
          if (request !== requestRef.current) return;
          setError(null);
          setItems((current) =>
            before === undefined ? page.data : [...(current ?? []), ...page.data],
          );
          setNext(page.next);
        },
        (e: unknown) => {
          if (request === requestRef.current) setError(userMessage(e));
        },
      );
    },
    [listConversations, document.id],
  );

  const listShown = open === null;
  useEffect(() => {
    if (listShown) load();
  }, [listShown, load]);

  const back = () => {
    setOpen(null);
    onBusyChange(false);
    onOpen(null);
  };

  return (
    <aside className="doc-questions" aria-label="Вопросы к документу">
      <div className="doc-questions-head">
        <h3>Вопросы</h3>
        <button
          type="button"
          className="button-secondary doc-close"
          aria-label="Закрыть вопросы"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      {open !== null ? (
        <QuestionThread
          key={open.key}
          document={document}
          conversationId={open.conversationId}
          draft={open.draft}
          models={models}
          deps={deps}
          onCreated={(id) => {
            // адрес догонит панель: смена questionId на этот id её не перезагрузит
            setOpen((current) => (current === null ? current : { ...current, conversationId: id }));
            onCountChange(1);
            onCreated(id);
          }}
          onDeleted={() => {
            onCountChange(-1);
            back();
          }}
          onBack={back}
          onQuoteClick={onQuoteClick}
          onBusyChange={onBusyChange}
        />
      ) : (
        <>
          {error !== null && (
            <ErrorBanner
              message={error}
              onRetry={() => {
                load();
              }}
            />
          )}
          {items !== null && items.length === 0 && error === null && (
            <p className="muted small doc-questions-empty">
              Выделите непонятное место в документе и нажмите «Спросить модель» — ответ и уточнения
              сохранятся здесь.
            </p>
          )}
          {items !== null && items.length > 0 && (
            <ul className="doc-question-list">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="doc-question-item"
                    onClick={() => {
                      setOpen(fromQuestion(item.id));
                      onOpen(item.id);
                    }}
                  >
                    <span className="doc-question-quote">«{item.quote ?? item.title}»</span>
                    <span className="chat-list-meta">{formatDate(item.updated_at, now)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {next !== null && (
            <button
              type="button"
              className="button-secondary chat-more"
              onClick={() => {
                load(next);
              }}
            >
              Показать ещё
            </button>
          )}
        </>
      )}
    </aside>
  );
}
