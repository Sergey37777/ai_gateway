const BARS = 48;

// детерминированный «профиль речи» из суммы синусов: одинаковый при каждом рендере и в тестах
const HEIGHTS: readonly { id: string; height: number }[] = Array.from({ length: BARS }, (_, i) => {
  const v =
    0.5 + 0.26 * Math.sin(i * 0.42) + 0.16 * Math.sin(i * 1.73 + 1) + 0.1 * Math.sin(i * 3.1 + 2);
  return { id: `bar-${String(i)}`, height: Math.round(Math.min(1, Math.max(0.14, v)) * 100) };
});

interface Props {
  /**
   * `undefined` — декоративная волна; `null` — неопределённый ход (идёт работа);
   * число 0–1 — доля выполненного, волна заполняется слева направо.
   */
  progress?: number | null | undefined;
}

function Bars() {
  return HEIGHTS.map(({ id, height }) => (
    <span key={id} className="wave-bar" style={{ height: `${String(height)}%` }} />
  ));
}

/** Звуковая волна — фирменный мотив: зона загрузки и индикатор прогресса одновременно. */
export function Waveform({ progress }: Props) {
  const mode = progress === undefined ? "idle" : progress === null ? "indeterminate" : "progress";
  const fill =
    typeof progress === "number"
      ? { clipPath: `inset(0 ${String((1 - Math.min(1, Math.max(0, progress))) * 100)}% 0 0)` }
      : undefined;
  return (
    <div className={`wave wave-${mode}`} aria-hidden="true">
      <div className="wave-layer wave-track">
        <Bars />
      </div>
      {mode !== "idle" && (
        <div className="wave-layer wave-fill" style={fill}>
          <Bars />
        </div>
      )}
    </div>
  );
}
