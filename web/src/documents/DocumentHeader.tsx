import { useState } from "react";
import { TitleEditor } from "../components/TitleEditor";
import { questionsLabel } from "./format";

export type ViewMode = "preview" | "split" | "source";

const MODES: { id: ViewMode; label: string }[] = [
  { id: "preview", label: "Превью" },
  { id: "split", label: "Рядом" },
  { id: "source", label: "Исходник" },
];

interface Props {
  title: string;
  mode: ViewMode;
  canSplit: boolean;
  onMode: (mode: ViewMode) => void;
  saveLabel: string | null;
  questionCount: number;
  questionsOpen: boolean;
  onToggleQuestions: () => void;
  onRename: (title: string) => void;
  onDownload: () => void;
  onDelete: () => void;
  /** Кнопка «Оглавление» (когда колонки оглавления нет). */
  onOutline: (() => void) | null;
}

/** Шапка документа: название, режим просмотра, вопросы, скачивание, удаление, сохранение. */
export function DocumentHeader({
  title,
  mode,
  canSplit,
  onMode,
  saveLabel,
  questionCount,
  questionsOpen,
  onToggleQuestions,
  onRename,
  onDownload,
  onDelete,
  onOutline,
}: Props) {
  const [renaming, setRenaming] = useState(false);
  return (
    <div className="doc-header">
      <div className="doc-header-title">
        {renaming ? (
          <TitleEditor
            title={title}
            onSave={(value) => {
              setRenaming(false);
              onRename(value);
            }}
            onCancel={() => {
              setRenaming(false);
            }}
          />
        ) : (
          <h2 className="chat-title">{title}</h2>
        )}
        {saveLabel !== null && <span className="muted small doc-save">{saveLabel}</span>}
      </div>
      <div className="doc-header-bar">
        <div className="doc-modes" role="radiogroup" aria-label="Вид">
          {MODES.filter((m) => canSplit || m.id !== "split").map(({ id, label }) => (
            <label key={id} className={mode === id ? "doc-mode doc-mode-active" : "doc-mode"}>
              <input
                type="radio"
                name="doc-mode"
                value={id}
                checked={mode === id}
                onChange={() => {
                  onMode(id);
                }}
              />
              {label}
            </label>
          ))}
        </div>
        {onOutline !== null && (
          <button type="button" className="button-secondary" onClick={onOutline}>
            Оглавление
          </button>
        )}
        <button
          type="button"
          className={
            questionsOpen ? "button-secondary doc-questions-toggle-on" : "button-secondary"
          }
          aria-pressed={questionsOpen}
          onClick={onToggleQuestions}
        >
          {questionCount > 0 ? `Вопросы · ${questionsLabel(questionCount)}` : "Вопросы"}
        </button>
        <div className="doc-header-actions">
          <button
            type="button"
            className="button-secondary"
            onClick={() => {
              setRenaming(true);
            }}
          >
            Переименовать
          </button>
          <button type="button" className="button-secondary" onClick={onDownload}>
            Скачать
          </button>
          <button type="button" className="button-secondary button-quiet-danger" onClick={onDelete}>
            Удалить
          </button>
        </div>
      </div>
    </div>
  );
}
