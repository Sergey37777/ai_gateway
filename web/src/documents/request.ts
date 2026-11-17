/** Запрос к модели для вопроса по документу: свой системный промпт и цитата в первом вопросе. */

import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions";
import { buildRequest, type ChatSettings } from "../chat/request";
import type { ChatMessage } from "../chat/state";

/**
 * Как предлагать правки (этап 6.1): блоки SEARCH/REPLACE, их разбирает `edits.ts`, применяет
 * пользователь кнопкой. Без просьбы о правке модель отвечает как раньше.
 */
export const EDIT_INSTRUCTIONS =
  "Если пользователь просит изменить документ (исправить, переписать, дополнить, удалить), " +
  "коротко опиши правку и дай её блоками ровно такого вида:\n" +
  "<<<<<<< SEARCH\nточный фрагмент документа\n=======\nновый текст\n>>>>>>> REPLACE\n" +
  "SEARCH копирует текст документа символ в символ (с разметкой Markdown) и достаточно длинный, " +
  "чтобы встречаться в документе один раз; служебные строки «Раздел:», «Оглавление документа:» " +
  "и «[…]» в SEARCH не включай. Несколько мест — несколько блоков. Чтобы дописать текст в конец " +
  "документа, оставь SEARCH пустым. Правку применит пользователь. Если правку не просили — " +
  "блоки не используй.";

export function documentSystemPrompt(title: string, context: string): string {
  return (
    `Ты помогаешь читать документ «${title}». Ниже — его часть. Объясняй простыми словами, ` +
    "по-русски, опираясь на документ; если в документе ответа нет — так и скажи и объясни " +
    `из общих знаний.\n\n${EDIT_INSTRUCTIONS}\n\nДокумент:\n\n${context}`
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
