import { expect, test } from "vitest";
import type { TranscriptionJob } from "../api/types";
import { formatDate, statusLabel } from "./format";

const JOB: TranscriptionJob = {
  id: "1",
  status: "done",
  source: "ui",
  title: "a",
  filename: "a.wav",
  model: "m",
  language: "ru",
  duration: 10,
  progress: 1,
  queue_position: null,
  error: null,
  has_audio: true,
  retryable: false,
  created_at: "2026-11-04T18:02:00Z",
  started_at: null,
  finished_at: null,
};

test("formatDate: сегодня — только время, иначе дата и время", () => {
  const now = new Date(2026, 10, 4, 20, 0);
  expect(formatDate(new Date(2026, 10, 4, 18, 2).toISOString(), now)).toBe("18:02");
  expect(formatDate(new Date(2026, 10, 3, 9, 5).toISOString(), now)).toBe("3 нояб., 09:05");
});

test("statusLabel по статусам", () => {
  expect(statusLabel({ ...JOB, status: "queued", queue_position: 2 })).toBe("В очереди: 2-я");
  expect(statusLabel({ ...JOB, status: "queued", queue_position: null })).toBe("В очереди");
  expect(statusLabel({ ...JOB, status: "running", progress: 0.42 })).toBe("Распознаётся — 42%");
  expect(statusLabel({ ...JOB, status: "running", progress: null })).toBe("Распознаётся");
  expect(statusLabel(JOB)).toBe("Готово");
  expect(statusLabel({ ...JOB, status: "failed" })).toBe("Ошибка");
  expect(statusLabel({ ...JOB, status: "cancelled" })).toBe("Отменено");
});
