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
    <div className="stack">
      <div className="card stack">
        <div className="result-head">
          <div>
            <h2 className="result-title">{source.name}</h2>
            <p className="muted">
              {result.language !== "" && `${result.language} · `}
              {formatClock(result.duration)}
            </p>
          </div>
          <button type="button" className="button-secondary" onClick={onReset}>
            Распознать другой файл
          </button>
        </div>
        {!playerFailed &&
          (video ? (
            <video className="player player-video" {...mediaProps} />
          ) : (
            <audio className="player" {...mediaProps} />
          ))}
        {playerFailed && <p className="muted">Браузер не может воспроизвести этот файл</p>}
        <div className="row downloads">
          <span className="muted">Скачать:</span>
          {EXPORT_FORMATS.map((format) => (
            <button
              key={format}
              type="button"
              className="button-secondary"
              onClick={() => {
                download(EXPORTERS[format](result), `${name}.${format}`, MIME[format]);
              }}
            >
              {format}
            </button>
          ))}
        </div>
      </div>

      {empty ? (
        <p className="card muted">Речь не распознана</p>
      ) : (
        <>
          <div className="card stack">
            <div className="result-head">
              <h3>Текст</h3>
              <CopyButton text={result.text.trim()} />
            </div>
            <p className="transcript-text">{result.text.trim()}</p>
          </div>
          <div className="card">
            <h3>Сегменты</h3>
            <ol className="segments">
              {result.segments.map((segment, index) => (
                <li key={segment.id} className={index === active ? "segment-active" : undefined}>
                  {playerFailed ? (
                    <span className="segment">
                      <span className="timestamp">[{formatClock(segment.start)}]</span>{" "}
                      {segment.text.trim()}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="segment"
                      onClick={() => {
                        seek(segment.start);
                      }}
                    >
                      <span className="timestamp">[{formatClock(segment.start)}]</span>{" "}
                      {segment.text.trim()}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </div>
        </>
      )}
    </div>
  );
}
