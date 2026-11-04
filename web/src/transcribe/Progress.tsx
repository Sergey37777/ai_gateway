import { useEffect, useState } from "react";
import { formatClock } from "./exports";
import { progressValue, type Phase } from "./state";

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

  let stage: string;
  let detail: string | null;
  switch (phase.name) {
    case "extracting":
      stage = "Извлечение аудио из видео…";
      detail = phase.progress === null ? null : percent(phase.progress);
      break;
    case "uploading":
      stage = "Загрузка…";
      detail = percent(phase.progress);
      break;
    case "transcribing":
      stage = "Распознавание…";
      detail = formatClock(Math.max(0, (now - phase.startedAt) / 1000));
      break;
    default:
      return null;
  }
  const label = detail === null ? stage : `${stage} ${detail}`;
  const value = progressValue(phase);

  return (
    <div className="progress">
      <p
        className="progress-label"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={typeof value === "number" ? Math.round(value * 100) : undefined}
        aria-live="polite"
      >
        {stage}
        {detail !== null && <span className="progress-detail"> {detail}</span>}
      </p>
      <button type="button" className="button-secondary" onClick={onCancel}>
        Отмена
      </button>
    </div>
  );
}
