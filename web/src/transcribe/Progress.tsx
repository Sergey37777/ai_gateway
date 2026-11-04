import { progressValue, type Phase } from "./state";

interface Props {
  phase: Phase;
  onCancel: () => void;
}

function percent(fraction: number): string {
  return `${String(Math.round(fraction * 100))}%`;
}

/** Ход приёма: извлечение → загрузка, с отменой (дальше ход показывает запись истории). */
export function Progress({ phase, onCancel }: Props) {
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
