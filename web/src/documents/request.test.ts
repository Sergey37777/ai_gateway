import { expect, test } from "vitest";
import type { ChatMessage } from "../chat/state";
import { buildQuestionRequest, documentSystemPrompt, questionHistory } from "./request";

const SETTINGS = {
  model: "gemma4-12b",
  systemPrompt: "промпт чата",
  temperature: 0.3,
  maxTokens: null,
  reasoningEffort: null,
};

const HISTORY: ChatMessage[] = [
  { id: 1, role: "user", text: "Что это значит?", images: [] },
  {
    id: 2,
    role: "assistant",
    content: "Блокировка строки.",
    reasoning: "",
    status: "done",
    usage: null,
    error: null,
    model: "gemma4-12b",
  },
  { id: 3, role: "user", text: "А зачем?", images: [] },
];

test("documentSystemPrompt: шаблон и контекст", () => {
  expect(documentSystemPrompt("Спека", "КОНТЕКСТ")).toBe(
    "Ты помогаешь читать документ «Спека». Ниже — его часть. Объясняй простыми словами, " +
      "по-русски, опираясь на документ; если в документе ответа нет — так и скажи и объясни " +
      "из общих знаний.\n\nКОНТЕКСТ",
  );
});

test("questionHistory: цитата только в первом вопросе", () => {
  const history = questionHistory(HISTORY, "FOR UPDATE");
  expect(history[0]).toEqual({
    id: 1,
    role: "user",
    text: "Фрагмент:\n«FOR UPDATE»\n\nВопрос: Что это значит?",
    images: [],
  });
  expect(history.slice(1)).toEqual(HISTORY.slice(1));
});

test("buildQuestionRequest: системный промпт документа вместо промпта чата", () => {
  const body = buildQuestionRequest(HISTORY, SETTINGS, {
    title: "Спека",
    context: "КОНТЕКСТ",
    quote: "FOR UPDATE",
  });
  expect(body.messages[0]).toEqual({
    role: "system",
    content: documentSystemPrompt("Спека", "КОНТЕКСТ"),
  });
  expect(body.messages[1]).toEqual({
    role: "user",
    content: "Фрагмент:\n«FOR UPDATE»\n\nВопрос: Что это значит?",
  });
  expect(body.messages).toHaveLength(4);
  expect(body.temperature).toBe(0.3);
});
