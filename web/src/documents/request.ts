/** Запрос к модели для вопроса по документу: свой системный промпт и цитата в первом вопросе. */

import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions";
import { buildRequest, type ChatSettings } from "../chat/request";
import type { ChatMessage } from "../chat/state";

export function documentSystemPrompt(title: string, context: string): string {
  return (
    `Ты помогаешь читать документ «${title}». Ниже — его часть. Объясняй простыми словами, ` +
    "по-русски, опираясь на документ; если в документе ответа нет — так и скажи и объясни " +
    `из общих знаний.\n\n${context}`
  );
}

/** История для модели: первый вопрос получает цитату (в БД хранится только сам вопрос). */
export function questionHistory(messages: ChatMessage[], quote: string): ChatMessage[] {
  const first = messages.findIndex((m) => m.role === "user");
  return messages.map((message, index) =>
    index === first && message.role === "user"
      ? { ...message, text: `Фрагмент:\n«${quote}»\n\nВопрос: ${message.text}` }
      : message,
  );
}

export function buildQuestionRequest(
  history: ChatMessage[],
  settings: ChatSettings,
  document: { title: string; context: string; quote: string },
): ChatCompletionCreateParamsStreaming {
  return buildRequest(questionHistory(history, document.quote), {
    ...settings,
    systemPrompt: documentSystemPrompt(document.title, document.context),
  });
}
