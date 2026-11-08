import { expect, test } from "vitest";
import { conversationHash, parseRoute, recordHash } from "./route";

test("parseRoute: вкладки и запись истории", () => {
  const none = { recordId: null, conversationId: null };
  expect(parseRoute("")).toEqual({ tab: "transcribe", ...none });
  expect(parseRoute("#transcribe")).toEqual({ tab: "transcribe", ...none });
  expect(parseRoute("#chat")).toEqual({ tab: "chat", ...none });
  expect(parseRoute("#history")).toEqual({ tab: "history", ...none });
  expect(parseRoute("#history/6f1c-aa")).toEqual({
    tab: "history",
    recordId: "6f1c-aa",
    conversationId: null,
  });
  expect(parseRoute("#history/")).toEqual({ tab: "history", ...none });
  expect(parseRoute("#что-то")).toEqual({ tab: "transcribe", ...none });
});

test("parseRoute: диалог чата", () => {
  expect(parseRoute("#chat/0b7e-1")).toEqual({
    tab: "chat",
    recordId: null,
    conversationId: "0b7e-1",
  });
  expect(parseRoute("#chat/a%20b")).toEqual({ tab: "chat", recordId: null, conversationId: "a b" });
  expect(parseRoute("#chat/")).toEqual({ tab: "chat", recordId: null, conversationId: null });
});

test("recordHash и conversationHash", () => {
  expect(recordHash("6f1c")).toBe("#history/6f1c");
  expect(conversationHash("a b")).toBe("#chat/a%20b");
});
