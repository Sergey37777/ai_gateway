import { expect, test } from "vitest";
import { conversationHash, documentHash, parseRoute, recordHash } from "./route";

test("parseRoute: вкладки и запись истории", () => {
  const none = { recordId: null, conversationId: null, documentId: null, questionId: null };
  expect(parseRoute("")).toEqual({ tab: "transcribe", ...none });
  expect(parseRoute("#transcribe")).toEqual({ tab: "transcribe", ...none });
  expect(parseRoute("#chat")).toEqual({ tab: "chat", ...none });
  expect(parseRoute("#history")).toEqual({ tab: "history", ...none });
  expect(parseRoute("#history/6f1c-aa")).toEqual({ ...none, tab: "history", recordId: "6f1c-aa" });
  expect(parseRoute("#history/")).toEqual({ tab: "history", ...none });
  expect(parseRoute("#что-то")).toEqual({ tab: "transcribe", ...none });
});

test("parseRoute: диалог чата", () => {
  const none = { recordId: null, conversationId: null, documentId: null, questionId: null };
  expect(parseRoute("#chat/0b7e-1")).toEqual({ ...none, tab: "chat", conversationId: "0b7e-1" });
  expect(parseRoute("#chat/a%20b")).toEqual({ ...none, tab: "chat", conversationId: "a b" });
  expect(parseRoute("#chat/")).toEqual({ ...none, tab: "chat" });
});

test("recordHash и conversationHash", () => {
  expect(recordHash("6f1c")).toBe("#history/6f1c");
  expect(conversationHash("a b")).toBe("#chat/a%20b");
});

test("parseRoute: документ и вопрос к нему", () => {
  const none = { recordId: null, conversationId: null, documentId: null, questionId: null };
  expect(parseRoute("#documents")).toEqual({ ...none, tab: "documents" });
  expect(parseRoute("#documents/")).toEqual({ ...none, tab: "documents" });
  expect(parseRoute("#documents/d%201")).toEqual({ ...none, tab: "documents", documentId: "d 1" });
  expect(parseRoute("#documents/d1/q1")).toEqual({
    ...none,
    tab: "documents",
    documentId: "d1",
    questionId: "q1",
  });
  expect(parseRoute("#documents/d1/")).toEqual({ ...none, tab: "documents", documentId: "d1" });
});

test("documentHash", () => {
  expect(documentHash("d 1")).toBe("#documents/d%201");
  expect(documentHash("d1", null)).toBe("#documents/d1");
  expect(documentHash("d1", "q 1")).toBe("#documents/d1/q%201");
});
