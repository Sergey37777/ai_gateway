import { expect, test } from "vitest";
import { parseRoute, recordHash } from "./route";

test("parseRoute: вкладки и запись истории", () => {
  expect(parseRoute("")).toEqual({ tab: "transcribe", recordId: null });
  expect(parseRoute("#transcribe")).toEqual({ tab: "transcribe", recordId: null });
  expect(parseRoute("#chat")).toEqual({ tab: "chat", recordId: null });
  expect(parseRoute("#history")).toEqual({ tab: "history", recordId: null });
  expect(parseRoute("#history/6f1c-aa")).toEqual({ tab: "history", recordId: "6f1c-aa" });
  expect(parseRoute("#history/")).toEqual({ tab: "history", recordId: null });
  expect(parseRoute("#что-то")).toEqual({ tab: "transcribe", recordId: null });
});

test("recordHash", () => {
  expect(recordHash("6f1c")).toBe("#history/6f1c");
});
