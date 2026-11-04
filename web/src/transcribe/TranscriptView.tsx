import { useEffect, useRef, useState } from "react";
import type { Transcription } from "../api/types";
import { CopyButton } from "../components/CopyButton";
import { EXPORT_FORMATS, EXPORTERS, formatClock, type ExportFormat } from "./exports";
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

/** Таймкод сегмента; скобки — только для доступного имени ("[00:00:01] текст"). */
function Timecode({ seconds }: { seconds: number }) {
  return (
    <span className="timestamp">
      <span className="visually-hidden">[</span>
      {formatClock(seconds)}
      <span className="visually-hidden">]</span>
    </span>
  );
}

/** Результат: плеер, текст, сегменты с перемоткой, скачивание. */
export function TranscriptView({ result, source, onReset }: Props) {
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [playerFailed, setPlayerFailed] = useState(false);
  const [active, setActive] = useState<number | null>(null);
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

  const seek = (start: number) => {
    const element = mediaRef.current;
    if (element === null || playerFailed) return;
    element.currentTime = start;
    element.play().catch(() => {
      // автовоспроизведение запрещено — пользователь нажмёт play сам
    });
  };

  const onTimeUpdate = () => {
    const time = mediaRef.current?.currentTime ?? 0;
    const index = result.segments.findIndex((s) => time >= s.start && time < s.end);
    setActive(index < 0 ? null : index);
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
                <span className="muted small">Нажмите на фразу, чтобы перемотать к ней</span>
              )}
            </div>
            <ol className="segments">
              {result.segments.map((segment, index) => (
                <li key={segment.id} className={index === active ? "segment-active" : undefined}>
                  {playerFailed ? (
                    <span className="segment">
                      <Timecode seconds={segment.start} />{" "}
                      <span className="segment-text">{segment.text.trim()}</span>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="segment"
                      onClick={() => {
                        seek(segment.start);
                      }}
                    >
                      <Timecode seconds={segment.start} />{" "}
                      <span className="segment-text">{segment.text.trim()}</span>
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </div>
  );
}
