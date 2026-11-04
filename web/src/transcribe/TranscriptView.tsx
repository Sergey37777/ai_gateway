import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { Transcription } from "../api/types";
import { CopyButton } from "../components/CopyButton";
import { EXPORT_FORMATS, EXPORTERS, formatClock, type ExportFormat } from "./exports";
import { SegmentRow } from "./SegmentRow";
import { activeIndex, groupWords } from "./words";

interface Props {
  result: Transcription;
  title: string;
  /** Вместо заголовка (например, поле переименования). */
  titleSlot?: ReactNode;
  /** Что играть: исходный файл (свежая загрузка) или Opus из истории; `null` — аудио нет. */
  media: Blob | null;
  video: boolean;
  /** Имя скачиваемых файлов без расширения. */
  downloadName: string;
  /** Действия записи под скачиванием (переименование, удаление). */
  actions?: ReactNode;
}

const MIME: Record<ExportFormat, string> = {
  txt: "text/plain;charset=utf-8",
  srt: "application/x-subrip;charset=utf-8",
  vtt: "text/vtt;charset=utf-8",
  json: "application/json",
};

function download(content: string, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Результат: плеер, текст, сегменты с перемоткой, скачивание. */
export function TranscriptView({
  result,
  title,
  titleSlot,
  media,
  video,
  downloadName,
  actions,
}: Props) {
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [playerFailed, setPlayerFailed] = useState(false);
  const seekable = media !== null && !playerFailed;
  const [active, setActive] = useState<{ segment: number; word: number | null } | null>(null);
  const groups = useMemo(() => groupWords(result.segments, result.words), [result]);

  // object URL не читает файл в память (важно для видео на гигабайты); src ставится напрямую,
  // чтобы URL жил ровно столько, сколько элемент
  useEffect(() => {
    const element = mediaRef.current;
    if (element === null || media === null) return undefined;
    const url = URL.createObjectURL(media);
    element.src = url;
    return () => {
      element.removeAttribute("src");
      URL.revokeObjectURL(url);
    };
  }, [media]);

  // стабильная ссылка: строки сегментов мемоизированы
  const seek = useCallback(
    (start: number) => {
      const element = mediaRef.current;
      if (element === null || !seekable) return;
      element.currentTime = start;
      element.play().catch(() => {
        // автовоспроизведение запрещено — пользователь нажмёт play сам
      });
    },
    [seekable],
  );

  const onTimeUpdate = () => {
    const time = mediaRef.current?.currentTime ?? 0;
    const segment = activeIndex(result.segments, time);
    const word = segment === null ? null : activeIndex(groups[segment] ?? [], time);
    setActive((prev) =>
      prev?.segment === segment && prev.word === word
        ? prev
        : segment === null
          ? null
          : { segment, word },
    );
  };

  // клик по слову: один обработчик на весь список вместо десятков тысяч
  const onWordClick = (event: MouseEvent<HTMLOListElement>) => {
    if (!(event.target instanceof Element)) return;
    const start = event.target.closest("[data-start]")?.getAttribute("data-start");
    if (start !== null && start !== undefined) seek(Number(start));
  };

  const empty = result.text.trim() === "" && result.segments.length === 0;
  const mediaProps = {
    ref: mediaRef,
    controls: true,
    preload: "metadata" as const,
    onTimeUpdate,
    onError: () => {
      setPlayerFailed(true);
    },
  };

  return (
    <div className="result">
      <aside className="result-side">
        <div className="result-head">
          {titleSlot ?? <h2 className="result-title">{title}</h2>}
          <dl className="result-meta">
            {result.language !== "" && (
              <div>
                <dt>Язык</dt>
                <dd>{result.language}</dd>
              </div>
            )}
            <div>
              <dt>Длительность</dt>
              <dd className="tabular">{formatClock(result.duration)}</dd>
            </div>
          </dl>
        </div>
        {media !== null &&
          !playerFailed &&
          (video ? (
            <video className="player player-video" {...mediaProps} />
          ) : (
            <audio className="player" {...mediaProps} />
          ))}
        {media === null && <p className="muted small">Аудио для этой записи не сохранилось</p>}
        {playerFailed && <p className="muted">Браузер не может воспроизвести этот файл</p>}
        <div className="downloads">
          <span className="muted small">Скачать</span>
          <div className="downloads-list">
            {EXPORT_FORMATS.map((format) => (
              <button
                key={format}
                type="button"
                className="button-chip"
                onClick={() => {
                  download(EXPORTERS[format](result), `${downloadName}.${format}`, MIME[format]);
                }}
              >
                {format}
              </button>
            ))}
          </div>
        </div>
        {actions}
      </aside>

      {empty ? (
        <p className="sheet muted result-main">Речь не распознана</p>
      ) : (
        <div className="result-main">
          <section className="sheet">
            <div className="sheet-head">
              <h3>Текст</h3>
              <CopyButton text={result.text.trim()} />
            </div>
            <p className="transcript-text">{result.text.trim()}</p>
          </section>
          <section className="sheet">
            <div className="sheet-head">
              <h3>Сегменты</h3>
              {seekable && (
                <span className="muted small">Нажмите на слово или таймкод, чтобы перемотать</span>
              )}
            </div>
            <ol className="segments" onClick={onWordClick}>
              {result.segments.map((segment, index) => (
                <SegmentRow
                  key={segment.id}
                  segment={segment}
                  words={groups[index] ?? []}
                  active={active?.segment === index}
                  activeWord={active?.segment === index ? active.word : null}
                  seekable={seekable}
                  onSeek={seek}
                />
              ))}
            </ol>
          </section>
        </div>
      )}
    </div>
  );
}
