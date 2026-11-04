import { expect, test } from "vitest";
import type { Transcription } from "../api/types";
import {
  initialTranscribeState,
  progressValue,
  transcribeReducer,
  type TranscribeAction,
} from "./state";

const RESULT: Transcription = {
  text: "x",
  language: "english",
  duration: 1,
  segments: [],
  words: [],
  raw: "{}",
};
const source = new File(["v"], "a.mp4", { type: "video/mp4" });
const audio = new File(["a"], "a.mka", { type: "audio/x-matroska" });

function run(...actions: TranscribeAction[]) {
  return actions.reduce(transcribeReducer, initialTranscribeState);
}

test("путь с извлечением", () => {
  let s = run({ type: "start", opId: 1, source, extract: true });
  expect(s.phase).toEqual({ name: "extracting", progress: null });
  s = transcribeReducer(s, { type: "extractProgress", opId: 1, progress: 0.5 });
  expect(s.phase).toEqual({ name: "extracting", progress: 0.5 });
  s = transcribeReducer(s, { type: "extracted", opId: 1, file: audio });
  expect(s.phase).toEqual({ name: "uploading", progress: 0 });
  expect(s.source).toBe(source);
  s = transcribeReducer(s, { type: "uploadProgress", opId: 1, progress: 0.7 });
  s = transcribeReducer(s, { type: "uploaded", opId: 1, now: 1000 });
  expect(s.phase).toEqual({ name: "transcribing", startedAt: 1000 });
  s = transcribeReducer(s, { type: "done", opId: 1, result: RESULT });
  expect(s.phase).toEqual({ name: "done", result: RESULT });
});

test("путь без извлечения", () => {
  const s = run({ type: "start", opId: 1, source: audio, extract: false });
  expect(s.phase).toEqual({ name: "uploading", progress: 0 });
});

test("события устаревшей операции игнорируются", () => {
  const s = run(
    { type: "start", opId: 1, source, extract: true },
    { type: "cancel" },
    { type: "start", opId: 2, source: audio, extract: false },
    { type: "extractProgress", opId: 1, progress: 0.9 },
    { type: "done", opId: 1, result: RESULT },
    { type: "fail", opId: 1, message: "старая" },
  );
  expect(s.opId).toBe(2);
  expect(s.phase).toEqual({ name: "uploading", progress: 0 });
  expect(s.source).toBe(audio);
});

test("после cancel поздний done старой операции не меняет idle", () => {
  const s = run(
    { type: "start", opId: 1, source, extract: false },
    { type: "cancel" },
    {
      type: "done",
      opId: 1,
      result: RESULT,
    },
  );
  expect(s.phase).toEqual({ name: "idle" });
  expect(s.source).toBeNull();
});

test("fail и reset", () => {
  let s = run(
    { type: "start", opId: 1, source, extract: false },
    {
      type: "fail",
      opId: 1,
      message: "плохо",
    },
  );
  expect(s.phase).toEqual({ name: "error", message: "плохо" });
  s = transcribeReducer(s, { type: "reset" });
  expect(s.phase).toEqual({ name: "idle" });
  expect(s.source).toBeNull();
});

test("доля для волны: известна при загрузке, без оценки при распознавании, нет вне операции", () => {
  expect(progressValue({ name: "uploading", progress: 0.4 })).toBe(0.4);
  expect(progressValue({ name: "extracting", progress: null })).toBeNull();
  expect(progressValue({ name: "transcribing", startedAt: 0 })).toBeNull();
  expect(progressValue({ name: "idle" })).toBeUndefined();
});
