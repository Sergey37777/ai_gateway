import { useId, useRef, useState } from "react";

interface Props {
  disabled: boolean;
  onFile: (file: File) => void;
}

/** Выбор файла кнопкой или перетаскиванием. */
export function FilePicker({ disabled, onFile }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const hintId = useId();

  return (
    <div
      className={`dropzone${dragOver ? " dropzone-active" : ""}${disabled ? " dropzone-disabled" : ""}`}
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
      <input
        ref={inputRef}
        type="file"
        accept="audio/*,video/*"
        aria-label="Аудио или видео файл"
        aria-describedby={hintId}
        className="visually-hidden"
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // сброс, чтобы повторный выбор того же файла снова вызвал change
          event.target.value = "";
          if (file !== undefined) onFile(file);
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          inputRef.current?.click();
        }}
      >
        Выбрать файл
      </button>
      <p id={hintId} className="muted">
        или перетащите сюда аудио или видео
      </p>
    </div>
  );
}
