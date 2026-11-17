import { useRef } from "react";
import { Message, type RenderAssistant } from "./Message";
import type { ChatMessage } from "./state";
import { useFollowEnd } from "./useFollowEnd";

interface Props {
  messages: ChatMessage[];
  busy: boolean;
  onEdit: (id: number, text: string) => void;
  onRegenerate: () => void;
  /** Содержимое ответа модели вместо Markdown (правки документа). */
  renderAssistant?: RenderAssistant;
}

export function MessageList({ messages, busy, onEdit, onRegenerate, renderAssistant }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useFollowEnd(endRef);

  return (
    <div className="chat-messages">
      {messages.map((message, index) => (
        <Message
          key={message.id}
          message={message}
          isLast={index === messages.length - 1}
          busy={busy}
          onEdit={onEdit}
          onRegenerate={onRegenerate}
          {...(renderAssistant !== undefined && { renderAssistant })}
        />
      ))}
      <div ref={endRef} />
    </div>
  );
}
