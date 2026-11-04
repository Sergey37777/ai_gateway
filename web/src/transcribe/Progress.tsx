import { useEffect, useState } from "react";
import { formatClock } from "./exports";
import type { Phase } from "./state";

interface Props {
  phase: Phase;
  onCancel: () => void;
}

function percent(fraction: number): string {
  return `${String(Math.round(fraction * 100))}%`;
}

/** Ход операции: извлечение → загрузка → распознавание, с отменой. */
export function Progress({ phase, onCancel }: Props) {
  const [now, setNow] = useState(() => Date.now());
  const transcribing = phase.name === "transcribing";

  useEffect(() => {
    if (!transcribing) return undefined;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [transcribing]);

  let label: string;
  let value: number | null = null;
  switch (phase.name) {
    case "extracting":
      label =
        phase.progress === null
          ? "Извлечение аудио из видео…"
          : `Извлечение аудио из видео… ${percent(phase.progress)}`;
      value = phase.progress;
      break;
    case "uploading":
      label = `Загрузка… ${percent(phase.progress)}`;
      value = phase.progress;
      break;
    case "transcribing":
      label = `Распознавание… ${formatClock(Math.max(0, (now - phase.startedAt) / 1000))}`;
      break;
    default:
      return null;
  }

  return (
    <div className="card progress" aria-live="polite">
      <div className="progress-head">
        <span>{label}</span>
        <button type="button" className="button-secondary" onClick={onCancel}>
          Отмена
        </button>
      </div>
      {value === null ? (
        <progress aria-label={label} />
      ) : (
        <progress aria-label={label} max={1} value={value} />
      )}
    </div>
  );
}
