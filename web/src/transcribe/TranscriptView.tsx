import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { Transcription } from "../api/types";
import { CopyButton } from "../components/CopyButton";
import { EXPORT_FORMATS, EXPORTERS, formatClock, type ExportFormat } from "./exports";
import { SegmentRow } from "./SegmentRow";
import { activeIndex, groupWords } from "./words";
import { baseName, isVideo } from "./media";

interface Props {
  result: Transcription;
  source: File;
  onReset: () => void;
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
export function TranscriptView({ result, source, onReset }: Props) {
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [playerFailed, setPlayerFailed] = useState(false);
  const [active, setActive] = useState<{ segment: number; word: number | null } | null>(null);
  const groups = useMemo(() => groupWords(result.segments, result.words), [result]);
  const video = isVideo(source);

  // object URL не читает файл в память (важно для видео на гигабайты); src ставится напрямую,
  // чтобы URL жил ровно столько, сколько элемент
  useEffect(() => {
    const element = mediaRef.current;
    if (element === null) return undefined;
    const url = URL.createObjectURL(source);
    element.src = url;
    return () => {
      element.removeAttribute("src");
      URL.revokeObjectURL(url);
    };
  }, [source]);

  // стабильная ссылка: строки сегментов мемоизированы
  const seek = useCallback(
    (start: number) => {
      const element = mediaRef.current;
      if (element === null || playerFailed) return;
      element.currentTime = start;
      element.play().catch(() => {
        // автовоспроизведение запрещено — пользователь нажмёт play сам
      });
    },
    [playerFailed],
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
  const name = baseName(source.name);
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
          <h2 className="result-title">{source.name}</h2>
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
        {!playerFailed &&
          (video ? (
            <video className="player player-video" {...mediaProps} />
          ) : (
            <audio className="player" {...mediaProps} />
          ))}
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
                  download(EXPORTERS[format](result), `${name}.${format}`, MIME[format]);
                }}
              >
                {format}
              </button>
            ))}
          </div>
        </div>
        <button type="button" className="button-secondary result-reset" onClick={onReset}>
          Распознать другой файл
        </button>
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
              {!playerFailed && (
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
                  seekable={!playerFailed}
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
