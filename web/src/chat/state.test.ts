import { expect, test } from "vitest";
import {
  chatReducer,
  historyBefore,
  initialChatState,
  type AssistantMessage,
  type ChatAction,
  type ChatState,
} from "./state";

function run(...actions: ChatAction[]): ChatState {
  return actions.reduce(chatReducer, initialChatState);
}

function last(state: ChatState): AssistantMessage {
  const message = state.messages.at(-1);
  if (message?.role !== "assistant") throw new Error("последнее сообщение — не ответ");
  return message;
}

/** Диалог из двух пар «вопрос — ответ». */
function twoTurns(): ChatState {
  let s = run({ type: "send", text: "раз", images: [] });
  s = chatReducer(s, { type: "started", id: last(s).id });
  s = chatReducer(s, { type: "delta", id: last(s).id, content: "ответ 1" });
  s = chatReducer(s, { type: "finish", id: last(s).id });
  s = chatReducer(s, { type: "send", text: "два", images: [] });
  s = chatReducer(s, { type: "started", id: last(s).id });
  s = chatReducer(s, { type: "delta", id: last(s).id, content: "ответ 2" });
  return chatReducer(s, { type: "finish", id: last(s).id });
}

test("send добавляет вопрос и пустой ответ, ставит pending", () => {
  const s = run({ type: "send", text: "привет", images: [] });
  expect(s.messages).toHaveLength(2);
  expect(s.messages[0]).toMatchObject({ role: "user", text: "привет" });
  expect(last(s)).toMatchObject({ content: "", reasoning: "", status: "streaming" });
  expect(s.pending).toBe(last(s).id);
  expect(s.streamingId).toBe(last(s).id);
  const started = chatReducer(s, { type: "started", id: last(s).id });
  expect(started.pending).toBeNull();
  expect(started.streamingId).toBe(last(s).id);
});

test("дельты копятся, usage и finish", () => {
  let s = run({ type: "send", text: "?", images: [] });
  const id = last(s).id;
  s = chatReducer(s, { type: "delta", id, reasoning: "ду" });
  s = chatReducer(s, { type: "delta", id, reasoning: "маю" });
  s = chatReducer(s, { type: "delta", id, content: "Отв" });
  s = chatReducer(s, { type: "delta", id, content: "ет" });
  s = chatReducer(s, { type: "usage", id, usage: { prompt_tokens: 5, completion_tokens: 7 } });
  s = chatReducer(s, { type: "finish", id });
  expect(last(s)).toMatchObject({
    content: "Ответ",
    reasoning: "думаю",
    status: "done",
    usage: { prompt_tokens: 5, completion_tokens: 7 },
  });
  expect(s.streamingId).toBeNull();
});

test("fail и stop", () => {
  let s = run({ type: "send", text: "?", images: [] });
  s = chatReducer(s, { type: "fail", id: last(s).id, message: "упало" });
  expect(last(s)).toMatchObject({ status: "error", error: "упало" });
  expect(s.streamingId).toBeNull();
  s = chatReducer(s, { type: "send", text: "ещё", images: [] });
  s = chatReducer(s, { type: "delta", id: last(s).id, content: "част" });
  s = chatReducer(s, { type: "stop", id: last(s).id });
  expect(last(s)).toMatchObject({ status: "stopped", content: "част" });
  expect(s.streamingId).toBeNull();
  expect(s.pending).toBeNull();
});

test("edit первого сообщения отбрасывает хвост и начинает новый ответ", () => {
  const s0 = twoTurns();
  expect(s0.messages).toHaveLength(4);
  const firstId = s0.messages[0]?.id ?? -1;
  const s = chatReducer(s0, { type: "edit", id: firstId, text: "раз, исправлено" });
  expect(s.messages).toHaveLength(2);
  expect(s.messages[0]).toMatchObject({ role: "user", text: "раз, исправлено" });
  expect(last(s).status).toBe("streaming");
  expect(s.pending).toBe(last(s).id);
});

test("regenerate заменяет последний ответ", () => {
  const s0 = twoTurns();
  const oldId = last(s0).id;
  const s = chatReducer(s0, { type: "regenerate" });
  expect(s.messages).toHaveLength(4);
  expect(last(s).id).not.toBe(oldId);
  expect(last(s)).toMatchObject({ content: "", status: "streaming" });
  expect(s.pending).toBe(last(s).id);
});

test("delta после clear и после stop игнорируется", () => {
  let s = run({ type: "send", text: "?", images: [] });
  const id = last(s).id;
  s = chatReducer(s, { type: "stop", id });
  s = chatReducer(s, { type: "delta", id, content: "поздно" });
  expect(last(s).content).toBe("");
  s = chatReducer(s, { type: "clear" });
  const afterClear = chatReducer(s, { type: "delta", id, content: "поздно" });
  expect(afterClear.messages).toEqual([]);
  expect(chatReducer(afterClear, { type: "finish", id })).toEqual(afterClear);
});

test("send/edit/regenerate во время стрима игнорируются", () => {
  const s = run({ type: "send", text: "?", images: [] });
  expect(chatReducer(s, { type: "send", text: "ещё", images: [] })).toBe(s);
  expect(chatReducer(s, { type: "regenerate" })).toBe(s);
  expect(chatReducer(s, { type: "edit", id: s.messages[0]?.id ?? -1, text: "x" })).toBe(s);
});

test("historyBefore — сообщения до ответа", () => {
  const s = twoTurns();
  const answerId = last(s).id;
  expect(historyBefore(s, answerId).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
});

test("id не повторяются после clear", () => {
  const s = chatReducer(twoTurns(), { type: "clear" });
  const next = chatReducer(s, { type: "send", text: "x", images: [] });
  expect(next.messages[0]?.id).toBeGreaterThanOrEqual(4);
});
