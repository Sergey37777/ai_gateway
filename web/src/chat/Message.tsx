import { useState } from "react";
import { CopyButton } from "../components/CopyButton";
import { Markdown } from "./Markdown";
import type { AssistantMessage, ChatMessage, UserMessage } from "./state";

interface Props {
  message: ChatMessage;
  isLast: boolean;
  /** Идёт стрим — правка и перегенерация недоступны. */
  busy: boolean;
  onEdit: (id: number, text: string) => void;
  onRegenerate: () => void;
}

function UserBubble({
  message,
  busy,
  onEdit,
}: {
  message: UserMessage;
  busy: boolean;
  onEdit: Props["onEdit"];
}) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft !== null) {
    return (
      <div className="message message-user">
        <textarea
          aria-label="Изменить сообщение"
          rows={3}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
        />
        <div className="message-actions">
          <button
            type="button"
            className="button-secondary"
            onClick={() => {
              setDraft(null);
            }}
          >
            Отмена
          </button>
          <button
            type="button"
            disabled={busy || draft.trim() === ""}
            onClick={() => {
              onEdit(message.id, draft.trim());
              setDraft(null);
            }}
          >
            Сохранить и отправить
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="message message-user">
      {message.images.length > 0 && (
        <ul className="thumbs">
          {message.images.map((image, index) => (
            <li key={`${image.name}-${String(index)}`}>
              <img src={image.dataUrl} alt={image.name} />
            </li>
          ))}
        </ul>
      )}
      {message.text !== "" && <p className="message-text">{message.text}</p>}
      <div className="message-actions">
        <button
          type="button"
          className="button-link"
          disabled={busy}
          onClick={() => {
            setDraft(message.text);
          }}
        >
          Изменить
        </button>
      </div>
    </div>
  );
}

function AssistantBubble({
  message,
  isLast,
  busy,
  onRegenerate,
}: {
  message: AssistantMessage;
  isLast: boolean;
  busy: boolean;
  onRegenerate: () => void;
}) {
  const streaming = message.status === "streaming";
  return (
    <div className="message message-assistant">
      {message.reasoning !== "" && (
        <details className="reasoning">
          <summary>
            Размышления
            {streaming && message.content === "" && <span className="muted"> — думает…</span>}
          </summary>
          <p className="reasoning-text">{message.reasoning}</p>
        </details>
      )}
      {message.content !== "" && <Markdown text={message.content} />}
      {streaming && message.content === "" && message.reasoning === "" && (
        <p className="muted typing">Генерация…</p>
      )}
      {message.status === "error" && message.error !== null && (
        <div className="error-banner" role="alert">
          <span>{message.error}</span>
          {isLast && (
            <button
              type="button"
              className="button-secondary"
              disabled={busy}
              onClick={onRegenerate}
            >
              Повторить
            </button>
          )}
        </div>
      )}
      <div className="message-meta">
        {message.status === "stopped" && <span className="muted">остановлено</span>}
        {message.usage !== null && (
          <span className="muted">
            запрос {message.usage.prompt_tokens} · ответ {message.usage.completion_tokens} токенов
          </span>
        )}
        {!streaming && message.content !== "" && <CopyButton text={message.content} />}
        {isLast && (message.status === "done" || message.status === "stopped") && (
          <button type="button" className="button-secondary" disabled={busy} onClick={onRegenerate}>
            Перегенерировать
          </button>
        )}
      </div>
    </div>
  );
}

export function Message({ message, isLast, busy, onEdit, onRegenerate }: Props) {
  return message.role === "user" ? (
    <UserBubble message={message} busy={busy} onEdit={onEdit} />
  ) : (
    <AssistantBubble message={message} isLast={isLast} busy={busy} onRegenerate={onRegenerate} />
  );
}
