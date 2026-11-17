import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type DragEvent,
  type SetStateAction,
} from "react";
import { listDocuments as defaultList } from "../api/documents";
import { userMessage } from "../api/errors";
import type { DocumentItem } from "../api/types";
import { ErrorBanner } from "../components/ErrorBanner";
import { formatDate } from "../history/format";
import { documentHash } from "../route";
import { formatChars, questionsLabel } from "./format";
import { ACCEPT } from "./upload";

interface Props {
  activeId: string | null;
  /** Элементы хранит родитель: после записи он сам обновляет размер и время. */
  items: DocumentItem[] | null;
  onItemsChange: Dispatch<SetStateAction<DocumentItem[] | null>>;
  /** Смена значения перечитывает список с сервера. */
  reloadKey: number;
  onNew: () => void;
  onUpload: (files: File[]) => void;
  /** Идёт загрузка: сколько документов создано из скольких (`null` — не идёт). */
  uploading: UploadProgress | null;
  uploadErrors: { name: string; message: string }[];
  /** Итоги по архивам. */
  uploadNotes: string[];
  /** Подмена API в тестах. */
  deps?: { listDocuments?: typeof defaultList };
}

export interface UploadProgress {
  done: number;
  total: number;
}

const SEARCH_DELAY = 300;

/** Боковая панель документов: создание, загрузка (кнопкой и перетаскиванием), поиск, список. */
export function DocumentList({
  activeId,
  items,
  onItemsChange,
  reloadKey,
  onNew,
  onUpload,
  uploading,
  uploadErrors,
  uploadNotes,
  deps,
}: Props) {
  const list = deps?.listDocuments ?? defaultList;
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [now] = useState(() => new Date());
  const fileRef = useRef<HTMLInputElement>(null);
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

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (files.length > 0) onUpload(files);
  };

  return (
    <nav
      className={
        dragging ? "chat-sidebar-inner doc-list doc-list-drop" : "chat-sidebar-inner doc-list"
      }
      aria-label="Документы"
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        const related = event.relatedTarget;
        if (related instanceof Node && event.currentTarget.contains(related)) return;
        setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div className="doc-list-actions">
        <button type="button" className="chat-new-button" onClick={onNew}>
          Новый документ
        </button>
        <button
          type="button"
          className="button-secondary"
          disabled={uploading !== null}
          onClick={() => {
            fileRef.current?.click();
          }}
        >
          {uploading === null
            ? "Загрузить"
            : uploading.total > 1
              ? `Загрузка ${String(uploading.done)}/${String(uploading.total)}…`
              : "Загрузка…"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          aria-label="Загрузить файлы"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            if (files.length > 0) onUpload(files);
          }}
        />
      </div>
      <p className="muted small doc-list-hint">
        .md, .txt, .pdf, .docx или архив .zip, .tar.gz — можно перетащить сюда
      </p>
      {uploadNotes.length > 0 && (
        <ul className="doc-upload-notes" role="status">
          {uploadNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
      {uploadErrors.length > 0 && (
        <ul className="doc-upload-errors" role="status">
          {uploadErrors.map((e, i) => (
            <li key={`${e.name}-${String(i)}`}>{`${e.name}: ${e.message}`}</li>
          ))}
        </ul>
      )}
      <input
        type="search"
        className="chat-search"
        aria-label="Поиск по документам"
        placeholder="Поиск по документам"
        value={input}
        onChange={(event) => {
          setInput(event.target.value);
        }}
      />
      {error !== null && <ErrorBanner message={error} onRetry={load} />}
      {items !== null && items.length === 0 && error === null && (
        <p className="muted small chat-list-empty">
          {query === "" ? "Документов пока нет" : `Ничего не нашлось по запросу «${query}»`}
        </p>
      )}
      {items !== null && items.length > 0 && (
        <ul className="chat-list">
          {items.map((document) => (
            <li key={document.id}>
              <a
                className="chat-list-item"
                href={documentHash(document.id)}
                aria-current={document.id === activeId ? "page" : undefined}
              >
                <span className="chat-list-title">{document.title}</span>
                <span className="chat-list-meta">
                  {formatDate(document.updated_at, now)} · {formatChars(document.chars)}
                  {document.question_count > 0 && ` · ${questionsLabel(document.question_count)}`}
                </span>
                {document.snippet !== undefined && (
                  <span className="chat-list-snippet">{document.snippet}</span>
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
