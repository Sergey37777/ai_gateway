/** Тестовые записи истории. */

import type { TranscriptionJob } from "../api/types";

export function job(overrides: Partial<TranscriptionJob> = {}): TranscriptionJob {
  return {
    id: "job-1",
    status: "done",
    source: "ui",
    title: "Совещание",
    filename: "meeting.m4a",
    model: "whisper-base",
    language: "ru",
    duration: 65,
    progress: 1,
    queue_position: null,
    error: null,
    has_audio: true,
    retryable: false,
    created_at: "2026-11-04T18:02:00Z",
    started_at: "2026-11-04T18:02:01Z",
    finished_at: "2026-11-04T18:03:00Z",
    ...overrides,
  };
}
