import { useEffect, useRef } from "react";
import { Message, type RenderAssistant } from "./Message";
import type { ChatMessage } from "./state";

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

  // прокрутка за стримом, если пользователь не ушёл читать выше
  useEffect(() => {
    const end = endRef.current;
    if (end === null || typeof end.scrollIntoView !== "function") return;
    const nearBottom = end.getBoundingClientRect().top - window.innerHeight < 240;
    if (nearBottom) end.scrollIntoView({ block: "end" });
  });

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
