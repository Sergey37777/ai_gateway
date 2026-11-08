import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { listConversations as defaultList } from "../api/conversations";
import { userMessage } from "../api/errors";
import type { ConversationItem } from "../api/types";
import { ErrorBanner } from "../components/ErrorBanner";
import { formatDate } from "../history/format";
import { conversationHash } from "../route";

interface Deps {
  listConversations?: typeof defaultList;
}

interface Props {
  activeId: string | null;
  /** Элементы хранит родитель: после записи он сам поднимает диалог и меняет название. */
  items: ConversationItem[] | null;
  onItemsChange: Dispatch<SetStateAction<ConversationItem[] | null>>;
  onNew: () => void;
  /** Смена значения перечитывает список с сервера (показ вкладки, создание, удаление). */
  reloadKey: number;
  /** Подмена API в тестах. */
  deps?: Deps;
}

const SEARCH_DELAY = 300;

/** Боковая панель чата: «Новый чат», поиск, список диалогов, подгрузка. */
export function ConversationList({
  activeId,
  items,
  onItemsChange,
  onNew,
  reloadKey,
  deps,
}: Props) {
  const list = deps?.listConversations ?? defaultList;
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [now] = useState(() => new Date());
  // ответ на устаревший запрос (поиск поменялся) не должен перезаписать список
  const requestRef = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(input.trim());
    }, SEARCH_DELAY);
    return () => {
      window.clearTimeout(timer);
    };
  }, [input]);

  const load = useCallback(() => {
    const request = ++requestRef.current;
    list(query === "" ? {} : { q: query }).then(
      (page) => {
        if (request !== requestRef.current) return;
        setError(null);
        onItemsChange(page.data);
        setNext(page.next);
      },
      (e: unknown) => {
        if (request === requestRef.current) setError(userMessage(e));
      },
    );
  }, [list, query, onItemsChange]);

  useEffect(() => {
    load();
  }, [load]);

  // reloadKey — сигнал родителя «перечитай»: важна смена значения, не само значение
  const reloadRef = useRef(reloadKey);
  useEffect(() => {
    if (reloadRef.current === reloadKey) return;
    reloadRef.current = reloadKey;
    load();
  }, [load, reloadKey]);

  const loadMore = () => {
    if (next === null) return;
    const request = requestRef.current;
    setLoadingMore(true);
    list(query === "" ? { before: next } : { q: query, before: next })
      .then(
        (page) => {
          if (request !== requestRef.current) return;
          onItemsChange((current) => [...(current ?? []), ...page.data]);
          setNext(page.next);
        },
        (e: unknown) => {
          setError(userMessage(e));
        },
      )
      .finally(() => {
        setLoadingMore(false);
      });
  };

  return (
    <nav className="chat-sidebar-inner" aria-label="Диалоги">
      <button type="button" className="chat-new-button" onClick={onNew}>
        Новый чат
      </button>
      <input
        type="search"
        className="chat-search"
        aria-label="Поиск по диалогам"
        placeholder="Поиск по диалогам"
        value={input}
        onChange={(event) => {
          setInput(event.target.value);
        }}
      />
      {error !== null && <ErrorBanner message={error} onRetry={load} />}
      {items !== null && items.length === 0 && error === null && (
        <p className="muted small chat-list-empty">
          {query === ""
            ? "Сохранённых диалогов пока нет"
            : `Ничего не нашлось по запросу «${query}»`}
        </p>
      )}
      {items !== null && items.length > 0 && (
        <ul className="chat-list">
          {items.map((conversation) => (
            <li key={conversation.id}>
              <a
                className="chat-list-item"
                href={conversationHash(conversation.id)}
                aria-current={conversation.id === activeId ? "page" : undefined}
              >
                <span className="chat-list-title">{conversation.title}</span>
                <span className="chat-list-meta">{formatDate(conversation.updated_at, now)}</span>
                {conversation.snippet !== undefined && (
                  <span className="chat-list-snippet">{conversation.snippet}</span>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
      {next !== null && (
        <button
          type="button"
          className="button-secondary chat-more"
          disabled={loadingMore}
          onClick={loadMore}
        >
          Показать ещё
        </button>
      )}
    </nav>
  );
}
