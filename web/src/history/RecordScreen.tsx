import { useCallback, useEffect, useState } from "react";
import { ApiError, userMessage } from "../api/errors";
import * as api from "../api/transcriptions";
import type { Transcription, TranscriptionJob } from "../api/types";
import { ErrorBanner } from "../components/ErrorBanner";
import { TitleEditor } from "../components/TitleEditor";
import { Waveform } from "../components/Waveform";
import { baseName, isVideo } from "../transcribe/media";
import { TranscriptView } from "../transcribe/TranscriptView";
import { formatDate, statusLabel } from "./format";
import { isActive, usePolling } from "./poll";

type Api = Pick<
  typeof api,
  | "getTranscription"
  | "getResult"
  | "getAudio"
  | "cancelTranscription"
  | "retryTranscription"
  | "renameTranscription"
  | "deleteTranscription"
>;

interface Props {
  id: string;
  /** Только что загруженный файл (с видеорядом) — играть его, а не Opus с сервера. */
  localFile: File | null;
  onDeleted: () => void;
  /** Подмена API в тестах. */
  deps?: Partial<Api>;
}

const POLL_INTERVAL = 1000;

type Loaded = { result: Transcription; media: Blob | null };

/** Запись истории: ход задачи с отменой, ошибка с повтором, готовый результат с действиями. */
export function RecordScreen({ id, localFile, onDeleted, deps }: Props) {
  const client: Api = { ...api, ...deps };
  const [job, setJob] = useState<TranscriptionJob | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [now] = useState(() => new Date());
  const { getTranscription, getResult, getAudio } = client;

  const fetchJob = useCallback(
    () =>
      getTranscription(id).then(
        (fresh) => {
          setJob(fresh);
          setError(null);
        },
        (e: unknown) => {
          if (e instanceof ApiError && e.status === 404) setMissing(true);
          else setError(userMessage(e));
        },
      ),
    [getTranscription, id],
  );

  useEffect(() => {
    void fetchJob();
  }, [fetchJob]);

  usePolling(fetchJob, POLL_INTERVAL, job !== null && isActive(job.status));

  const done = job?.status === "done";
  const hasAudio = job?.has_audio ?? false;
  useEffect(() => {
    if (!done || loaded !== null) return undefined;
    const stale = new AbortController();
    Promise.all([getResult(id), localFile ?? (hasAudio ? getAudio(id) : null)]).then(
      ([result, media]) => {
        if (!stale.signal.aborted) setLoaded({ result, media });
      },
      (e: unknown) => {
        if (!stale.signal.aborted) setError(userMessage(e));
      },
    );
    return () => {
      stale.abort();
    };
  }, [done, getAudio, getResult, hasAudio, id, localFile, loaded]);

  const act = (action: () => Promise<TranscriptionJob>) => {
    action().then(setJob, (e: unknown) => {
      setError(userMessage(e));
    });
  };

  if (missing) {
    return (
      <div className="record-missing">
        <p>Такой записи нет — возможно, её удалили</p>
        <a href="#history">Вся история</a>
      </div>
    );
  }
  if (job === null) {
    return error === null ? (
      <p className="muted">Загрузка…</p>
    ) : (
      <ErrorBanner message={error} onRetry={() => void fetchJob()} />
    );
  }

  const remove = () => {
    if (!window.confirm(`Удалить запись «${job.title}»? Текст и аудио пропадут.`)) return;
    client.deleteTranscription(id).then(onDeleted, (e: unknown) => {
      setError(userMessage(e));
    });
  };

  const title = renaming ? (
    <TitleEditor
      title={job.title}
      onSave={(value) => {
        setRenaming(false);
        act(() => client.renameTranscription(id, value));
      }}
      onCancel={() => {
        setRenaming(false);
      }}
    />
  ) : (
    <h2 className="record-title">{job.title}</h2>
  );

  const actions = (
    <div className="record-actions">
      <button
        type="button"
        className="button-secondary"
        onClick={() => {
          setRenaming(true);
        }}
      >
        Переименовать
      </button>
      <button type="button" className="button-secondary button-quiet-danger" onClick={remove}>
        Удалить
      </button>
    </div>
  );

  return (
    <div className="record stack">
      <a className="record-back" href="#history">
        Вся история
      </a>
      {error !== null && <ErrorBanner message={error} />}
      {done && loaded !== null ? (
        <TranscriptView
          result={loaded.result}
          title={renaming ? "" : job.title}
          titleSlot={renaming ? title : undefined}
          media={loaded.media}
          video={localFile !== null && isVideo(localFile)}
          downloadName={baseName(job.title)}
          actions={actions}
        />
      ) : (
        <section className="record-pending sheet">
          {title}
          <p className="record-meta muted small">
            <span>{formatDate(job.created_at, now)}</span>
            <span>{job.model}</span>
          </p>
          {isActive(job.status) && (
            <>
              <Waveform progress={job.status === "running" ? job.progress : null} />
              <div className="progress">
                <p className="progress-label" aria-live="polite">
                  {statusLabel(job)}
                </p>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => {
                    act(() => client.cancelTranscription(id));
                  }}
                >
                  Отмена
                </button>
              </div>
              <p className="muted small">
                Вкладку можно закрыть — распознавание идёт на сервере и сохранится в истории.
              </p>
            </>
          )}
          {job.status === "failed" && job.error !== null && (
            <ErrorBanner
              message={job.error.message}
              {...(job.retryable && {
                onRetry: () => {
                  act(() => client.retryTranscription(id));
                },
              })}
            />
          )}
          {job.status === "cancelled" && (
            <div className="row">
              <p className="muted">Распознавание отменено</p>
              {job.retryable && (
                <button
                  type="button"
                  onClick={() => {
                    act(() => client.retryTranscription(id));
                  }}
                >
                  Повторить
                </button>
              )}
            </div>
          )}
          {done && loaded === null && error === null && <p className="muted">Загрузка…</p>}
          {!isActive(job.status) && actions}
        </section>
      )}
    </div>
  );
}
