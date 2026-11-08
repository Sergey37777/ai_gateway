import { useState } from "react";

/** Поле переименования: Enter — сохранить (непустое), Esc или уход фокуса — отмена. */
export function TitleEditor({
  title,
  onSave,
  onCancel,
}: {
  title: string;
  onSave: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(title);
  return (
    <input
      className="title-input"
      aria-label="Название"
      autoFocus
      maxLength={200}
      value={value}
      onChange={(event) => {
        setValue(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && value.trim() !== "") onSave(value.trim());
        if (event.key === "Escape") onCancel();
      }}
      onBlur={onCancel}
    />
  );
}
