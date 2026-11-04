import { useId, useRef, useState, type ReactNode } from "react";
import { Waveform } from "../components/Waveform";

interface Props {
  disabled: boolean;
  onFile: (file: File) => void;
  /** Ход операции для волны (см. `Waveform`); `undefined` — операции нет. */
  progress?: number | null | undefined;
  /** Строка хода операции — заменяет заголовок и кнопку выбора, пока идёт работа. */
  status?: ReactNode;
  /** Дополнительные действия рядом с выбором файла (запись с микрофона). */
  children?: ReactNode;
  footnote?: ReactNode;
}

/** Выбор файла кнопкой или перетаскиванием; во время работы показывает её ход. */
export function FilePicker({ disabled, onFile, progress, status, children, footnote }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const hintId = useId();
  const working = status !== undefined && status !== null;

  const classes = ["dropzone"];
  if (dragOver) classes.push("dropzone-active");
  if (working) classes.push("dropzone-working");

  return (
    <div
      className={classes.join(" ")}
      onDragOver={(event) => {
        if (disabled) return;
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => {
        setDragOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        const file = event.dataTransfer.files[0];
        if (!disabled && file !== undefined) onFile(file);
      }}
    >
      <Waveform progress={progress} />
      <input
        ref={inputRef}
        type="file"
        accept="audio/*,video/*"
        aria-label="Аудио или видео файл"
        aria-describedby={working ? undefined : hintId}
        className="visually-hidden"
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // сброс, чтобы повторный выбор того же файла снова вызвал change
          event.target.value = "";
          if (file !== undefined) onFile(file);
        }}
      />
      <div className="dropzone-body">
        {working ? (
          status
        ) : (
          <h2 id={hintId} className="dropzone-title">
            {dragOver ? "Отпустите файл, чтобы распознать" : "Перетащите сюда аудио или видео"}
          </h2>
        )}
        <div className="dropzone-actions">
          {!working && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                inputRef.current?.click();
              }}
            >
              Выбрать файл
            </button>
          )}
          {children}
        </div>
        {footnote !== undefined && <p className="dropzone-note">{footnote}</p>}
      </div>
    </div>
  );
}
