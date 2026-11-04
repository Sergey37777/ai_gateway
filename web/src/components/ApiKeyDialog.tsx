import { useId, useState } from "react";

interface Props {
  message: string | null;
  onSave: (key: string) => void;
  onCancel?: () => void;
}

export function ApiKeyDialog({ message, onSave, onCancel }: Props) {
  const [value, setValue] = useState("");
  const inputId = useId();
  const titleId = useId();

  return (
    <div className="dialog-backdrop">
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(event) => {
          event.preventDefault();
          const key = value.trim();
          if (key !== "") onSave(key);
        }}
      >
        <h2 id={titleId}>Ключ API</h2>
        {message !== null && <p className="dialog-error">{message}</p>}
        <p className="muted">Шлюз требует ключ (AIGW_API_KEY). Он сохранится в этом браузере.</p>
        <label htmlFor={inputId}>API-ключ</label>
        <input
          id={inputId}
          type="password"
          autoComplete="off"
          autoFocus
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
          }}
        />
        <div className="dialog-actions">
          {onCancel !== undefined && (
            <button type="button" className="button-secondary" onClick={onCancel}>
              Отмена
            </button>
          )}
          <button type="submit" disabled={value.trim() === ""}>
            Сохранить
          </button>
        </div>
      </form>
    </div>
  );
}
