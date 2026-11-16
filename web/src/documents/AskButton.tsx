import { MAX_QUOTE } from "./limits";

interface Props {
  quote: string;
  /** Точка у конца выделения (превью); `null` — кнопка прикреплена к редактору. */
  at: { x: number; y: number } | null;
  onAsk: () => void;
}

/** Плавающая «Спросить модель» у выделения; mousedown не сбрасывает выделение. */
export function AskButton({ quote, at, onAsk }: Props) {
  const tooLong = quote.length > MAX_QUOTE;
  const style =
    at === null
      ? undefined
      : {
          left: `${String(Math.max(8, Math.min(at.x - 70, window.innerWidth - 180)))}px`,
          top: `${String(Math.min(at.y + 8, window.innerHeight - 48))}px`,
        };
  return (
    <button
      type="button"
      className={at === null ? "doc-ask doc-ask-docked" : "doc-ask"}
      style={style}
      disabled={tooLong}
      title={tooLong ? `Выделите не больше ${String(MAX_QUOTE)} знаков` : undefined}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={onAsk}
    >
      Спросить модель
    </button>
  );
}
