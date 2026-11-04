import { expect, test } from "vitest";
import {
  initialTranscribeState,
  isBusy,
  progressValue,
  transcribeReducer,
  type TranscribeAction,
} from "./state";

const source = new File(["v"], "a.mp4", { type: "video/mp4" });
const audio = new File(["a"], "a.mka", { type: "audio/x-matroska" });

function run(...actions: TranscribeAction[]) {
  return actions.reduce(transcribeReducer, initialTranscribeState);
}

test("путь с извлечением до создания задачи", () => {
  let s = run({ type: "start", opId: 1, source, extract: true });
  expect(s.phase).toEqual({ name: "extracting", progress: null });
  s = transcribeReducer(s, { type: "extractProgress", opId: 1, progress: 0.5 });
  expect(s.phase).toEqual({ name: "extracting", progress: 0.5 });
  s = transcribeReducer(s, { type: "extracted", opId: 1 });
  expect(s.phase).toEqual({ name: "uploading", progress: 0 });
  s = transcribeReducer(s, { type: "uploadProgress", opId: 1, progress: 0.7 });
  expect(s.phase).toEqual({ name: "uploading", progress: 0.7 });
  // задача создана — дальше работает сервер, приём снова свободен
  s = transcribeReducer(s, { type: "created", opId: 1 });
  expect(s).toEqual(initialTranscribeState);
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
    { type: "created", opId: 1 },
    { type: "fail", opId: 1, message: "старая" },
  );
  expect(s.opId).toBe(2);
  expect(s.phase).toEqual({ name: "uploading", progress: 0 });
});

test("fail и cancel", () => {
  let s = run(
    { type: "start", opId: 1, source, extract: false },
    { type: "fail", opId: 1, message: "плохо" },
  );
  expect(s.phase).toEqual({ name: "error", message: "плохо" });
  expect(isBusy(s.phase)).toBe(false);
  s = transcribeReducer(run({ type: "start", opId: 2, source, extract: false }), {
    type: "cancel",
  });
  expect(s.phase).toEqual({ name: "idle" });
});

test("доля для волны: известна при загрузке, без оценки при извлечении, нет вне операции", () => {
  expect(progressValue({ name: "uploading", progress: 0.4 })).toBe(0.4);
  expect(progressValue({ name: "extracting", progress: null })).toBeNull();
  expect(progressValue({ name: "idle" })).toBeUndefined();
  expect(progressValue({ name: "error", message: "x" })).toBeUndefined();
});
