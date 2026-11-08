import { describe, expect, test } from "vitest";
import type { ApiMessage } from "../api/types";
import {
  fromApiMessages,
  fromApiSettings,
  hasUnsaved,
  planWrite,
  titleFrom,
  toApiMessage,
  toApiSettings,
} from "./persist";
import type { AssistantMessage, ChatMessage, UserMessage } from "./state";

let nextId = 100;

function q(text: string, images: UserMessage["images"] = []): UserMessage {
  nextId += 1;
  return { id: nextId, role: "user", text, images };
}

function a(content: string, status: AssistantMessage["status"] = "done"): AssistantMessage {
  nextId += 1;
  return {
    id: nextId,
    role: "assistant",
    content,
    reasoning: "",
    status,
    usage: null,
    error: status === "error" ? "сломалось" : null,
    model: status === "streaming" ? null : "qwen3-0.6b",
  };
}

/** Снимок «сохранённого» по сообщениям UI. */
function saved(...messages: ChatMessage[]): ApiMessage[] {
  return messages.map((m) => {
    const api = toApiMessage(m);
    if (api === null) throw new Error("стримящийся ответ не сохраняется");
    return api;
  });
}

describe("planWrite", () => {
  test("отправка: вопрос пишется сразу", () => {
    const question = q("привет");
    expect(planWrite([], [question, a("", "streaming")])).toEqual({
      from: 0,
      messages: saved(question),
    });
  });

  test("готовый ответ дописывается", () => {
    const question = q("привет");
    const answer = a("здравствуйте");
    expect(planWrite(saved(question), [question, answer])).toEqual({
      from: 1,
      messages: saved(answer),
    });
  });

  test("«Стоп» с пустым ответом тоже сохраняется", () => {
    const question = q("привет");
    const stopped = a("", "stopped");
    expect(planWrite(saved(question), [question, stopped])).toEqual({
      from: 1,
      messages: [
        {
          role: "assistant",
          text: "",
          reasoning: "",
          status: "stopped",
          error: null,
          usage: null,
          model: "qwen3-0.6b",
        },
      ],
    });
  });

  test("правка вопроса во время стрима: вопрос пишется сразу, хвост отрезается", () => {
    const [q1, a1, q2, a2] = [q("раз"), a("один"), q("два"), a("два")];
    const edited: UserMessage = { ...q1, text: "раз!" };
    expect(planWrite(saved(q1, a1, q2, a2), [edited, a("", "streaming")])).toEqual({
      from: 0,
      messages: saved(edited),
    });
  });

  test("перегенерация: во время стрима — ничего, по окончании — замена ответа", () => {
    const [question, old] = [q("привет"), a("старый")];
    expect(planWrite(saved(question, old), [question, a("нов", "streaming")])).toBeNull();
    const fresh = a("новый");
    expect(planWrite(saved(question, old), [question, fresh])).toEqual({
      from: 1,
      messages: saved(fresh),
    });
  });

  test("после сбоя одна запись догоняет всё несохранённое", () => {
    const [q1, a1, q2] = [q("раз"), a("один"), q("два")];
    expect(planWrite(saved(q1), [q1, a1, q2, a("", "streaming")])).toEqual({
      from: 1,
      messages: saved(a1, q2),
    });
  });

  test("без изменений — null", () => {
    const [question, answer] = [q("привет"), a("ответ")];
    expect(planWrite(saved(question, answer), [question, answer])).toBeNull();
    expect(planWrite([], [])).toBeNull();
  });

  test("ответ с ошибкой сохраняется со статусом error", () => {
    const question = q("привет");
    const failed = a("", "error");
    expect(planWrite(saved(question), [question, failed])?.messages[0]).toMatchObject({
      status: "error",
      error: "сломалось",
    });
  });
});

test("hasUnsaved: перегенерация во время стрима — есть несохранённое", () => {
  const [question, old] = [q("привет"), a("старый")];
  expect(hasUnsaved(saved(question, old), [question, a("", "streaming")])).toBe(true);
  expect(hasUnsaved(saved(question, old), [question, old])).toBe(false);
});

test("toApiMessage / fromApiMessages: картинки и поля ответа", () => {
  const image = { name: "a.png", dataUrl: "data:image/png;base64,AA" };
  const question = q("что это?", [image]);
  const answer: AssistantMessage = {
    ...a("кот"),
    reasoning: "думаю",
    usage: { prompt_tokens: 3, completion_tokens: 1 },
  };
  const api = saved(question, answer);
  expect(api[0]).toEqual({
    role: "user",
    text: "что это?",
    images: [{ name: "a.png", data_url: image.dataUrl }],
  });
  const restored = fromApiMessages(api, 7);
  expect(restored.map((m) => m.id)).toEqual([7, 8]);
  expect(restored[0]).toEqual({ ...question, id: 7 });
  expect(restored[1]).toEqual({ ...answer, id: 8 });
  expect(toApiMessage(a("", "streaming"))).toBeNull();
});

describe("titleFrom", () => {
  test("первая непустая строка, пробелы схлопнуты", () => {
    expect(titleFrom("\n  Привет,   мир \nвторая", false)).toBe("Привет, мир");
  });
  test("длиннее 60 символов — 59 и многоточие", () => {
    const title = titleFrom("я".repeat(61), false);
    expect(title).toBe(`${"я".repeat(59)}…`);
    expect(titleFrom("я".repeat(60), false)).toBe("я".repeat(60));
  });
  test("эмодзи не режется посередине", () => {
    const title = titleFrom("😀".repeat(61), false);
    expect(Array.from(title)).toHaveLength(60);
    expect(title.endsWith("😀…")).toBe(true);
  });
  test("без текста", () => {
    expect(titleFrom("  \n ", true)).toBe("Картинка");
    expect(titleFrom("", false)).toBe("Новый диалог");
  });
});

test("toApiSettings / fromApiSettings", () => {
  const api = toApiSettings({
    model: "qwen3-0.6b",
    systemPrompt: "Кратко",
    temperature: 0.7,
    maxTokens: null,
    reasoningEffort: "low",
  });
  expect(api).toEqual({
    model: "qwen3-0.6b",
    system_prompt: "Кратко",
    temperature: 0.7,
    max_tokens: null,
    reasoning_effort: "low",
  });
  expect(fromApiSettings({ ...api, max_tokens: 256, reasoning_effort: null })).toEqual({
    model: "qwen3-0.6b",
    draft: { systemPrompt: "Кратко", temperature: "0.7", maxTokens: "256", reasoningEffort: "" },
  });
});
