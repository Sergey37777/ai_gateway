import { useCallback, useEffect, useRef, useState } from "react";
import { userMessage } from "../api/errors";
import { listTranscriptions as defaultList } from "../api/transcriptions";
import type { TranscriptionJob } from "../api/types";
import { ErrorBanner } from "../components/ErrorBanner";
import { Waveform } from "../components/Waveform";
import { formatClock } from "../transcribe/exports";
import { formatDate, statusLabel } from "./format";
import { isActive, usePolling } from "./poll";

interface Deps {
  listTranscriptions?: typeof defaultList;
}

interface Props {
  /** Подмена API в тестах. */
  deps?: Deps;
}

const SEARCH_DELAY = 300;
const POLL_INTERVAL = 3000;

function Item({ job, now }: { job: TranscriptionJob; now: Date }) {
  const active = isActive(job.status);
  return (
    <li>
      <a className={`history-item history-${job.status}`} href={`#history/${job.id}`}>
        <span className="history-title">{job.title}</span>
        <span className="history-meta">
          <span>{formatDate(job.created_at, now)}</span>
          {job.duration !== null && <span className="tabular">{formatClock(job.duration)}</span>}
          <span>{job.model}</span>
          {job.source === "api" && (
            <span className="badge" title="Распознано через API">
              API
            </span>
          )}
        </span>
        <span className="history-status">{statusLabel(job)}</span>
        {active && (
          <span className="history-wave">
            <Waveform progress={job.status === "running" ? job.progress : null} />
          </span>
        )}
        {job.snippet !== undefined && <span className="history-snippet">{job.snippet}</span>}
      </a>
    </li>
  );
}

/** История распознаваний: поиск, список, подгрузка; активные записи опрашиваются. */
export function HistoryScreen({ deps }: Props) {
  const list = deps?.listTranscriptions ?? defaultList;
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<TranscriptionJob[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // «сегодня» для подписей дат — на момент открытия экрана
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

  const params = useCallback(
    (extra: { before?: string } = {}) => {
      return query === "" ? extra : { q: query, ...extra };
    },
    [query],
  );

  const load = useCallback(() => {
    const request = ++requestRef.current;
    list(params()).then(
      (page) => {
        if (request !== requestRef.current) return;
        setError(null);
        setItems(page.data);
        setNext(page.next);
      },
      (e: unknown) => {
        if (request === requestRef.current) setError(userMessage(e));
      },
    );
  }, [list, params]);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = async () => {
    const request = requestRef.current;
    const page = await list(params());
    if (request !== requestRef.current) return;
    // свежие статусы первой страницы поверх уже загруженного списка
    const fresh = new Map(page.data.map((job) => [job.id, job]));
    setItems((current) => current?.map((job) => fresh.get(job.id) ?? job) ?? page.data);
  };
  usePolling(refresh, POLL_INTERVAL, items?.some((job) => isActive(job.status)) ?? false);

  const loadMore = () => {
    if (next === null) return;
    const request = requestRef.current;
    setLoadingMore(true);
    list(params({ before: next }))
      .then(
        (page) => {
          if (request !== requestRef.current) return;
          setItems((current) => [...(current ?? []), ...page.data]);
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
    <div className="history">
      <div className="history-search">
        <input
          type="search"
          aria-label="Поиск по истории"
          placeholder="Поиск по тексту и названию"
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
          }}
        />
      </div>
      {error !== null && <ErrorBanner message={error} onRetry={load} />}
      {items !== null && items.length === 0 && error === null && (
        <div className="history-empty">
          {query === "" ? (
            <>
              <p className="history-empty-title">Здесь появятся ваши распознавания</p>
              <p className="muted">
                Файлы из вкладки «Распознавание» и вызовы API сохраняются сюда вместе с аудио.
              </p>
            </>
          ) : (
            <p className="history-empty-title">Ничего не нашлось по запросу «{query}»</p>
          )}
        </div>
      )}
      {items !== null && items.length > 0 && (
        <ul className="history-list">
          {items.map((job) => (
            <Item key={job.id} job={job} now={now} />
          ))}
        </ul>
      )}
      {next !== null && (
        <button
          type="button"
          className="button-secondary history-more"
          disabled={loadingMore}
          onClick={loadMore}
        >
          Показать ещё
        </button>
      )}
    </div>
  );
}
