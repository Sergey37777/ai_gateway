import { useState } from "react";
import { TitleEditor } from "../components/TitleEditor";

interface Props {
  title: string;
  saving: boolean;
  onRename: (title: string) => void;
  onDelete: () => void;
}

/** Шапка сохранённого диалога: название, переименование, удаление, ход сохранения. */
export function ConversationHeader({ title, saving, onRename, onDelete }: Props) {
  const [renaming, setRenaming] = useState(false);
  return (
    <div className="chat-header">
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
      {saving && <span className="muted small chat-saving">Сохранение…</span>}
      <div className="chat-header-actions">
        <button
          type="button"
          className="button-secondary"
          onClick={() => {
            setRenaming(true);
          }}
        >
          Переименовать
        </button>
        <button type="button" className="button-secondary button-quiet-danger" onClick={onDelete}>
          Удалить
        </button>
      </div>
    </div>
  );
}
