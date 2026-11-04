/** Состояние экрана распознавания: фазы операции и защита от событий устаревших операций. */

import type { Transcription } from "../api/types";

export type Phase =
  | { name: "idle" }
  | { name: "extracting"; progress: number | null }
  | { name: "uploading"; progress: number }
  | { name: "transcribing"; startedAt: number }
  | { name: "done"; result: Transcription }
  | { name: "error"; message: string };

export interface TranscribeState {
  /** id текущей операции; 0 — операции нет (после cancel/reset поздние события игнорируются). */
  opId: number;
  phase: Phase;
  /** Исходный файл (для плеера), даже если на сервер ушла извлечённая дорожка. */
  source: File | null;
}

export type TranscribeAction =
  | { type: "start"; opId: number; source: File; extract: boolean }
  | { type: "extractProgress"; opId: number; progress: number }
  | { type: "extracted"; opId: number; file: File }
  | { type: "uploadProgress"; opId: number; progress: number }
  | { type: "uploaded"; opId: number; now: number }
  | { type: "done"; opId: number; result: Transcription }
  | { type: "fail"; opId: number; message: string }
  | { type: "cancel" }
  | { type: "reset" };

export const initialTranscribeState: TranscribeState = {
  opId: 0,
  phase: { name: "idle" },
  source: null,
};

function phaseFor(state: TranscribeState, action: TranscribeAction): Phase | null {
  switch (action.type) {
    case "extractProgress":
      return state.phase.name === "extracting"
        ? { name: "extracting", progress: action.progress }
        : null;
    case "extracted":
      return { name: "uploading", progress: 0 };
    case "uploadProgress":
      return state.phase.name === "uploading"
        ? { name: "uploading", progress: action.progress }
        : null;
    case "uploaded":
      return { name: "transcribing", startedAt: action.now };
    case "done":
      return { name: "done", result: action.result };
    case "fail":
      return { name: "error", message: action.message };
    case "start":
    case "cancel":
    case "reset":
      return null;
  }
}

export function transcribeReducer(
  state: TranscribeState,
  action: TranscribeAction,
): TranscribeState {
  switch (action.type) {
    case "start":
      return {
        opId: action.opId,
        phase: action.extract
          ? { name: "extracting", progress: null }
          : { name: "uploading", progress: 0 },
        source: action.source,
      };
    case "cancel":
    case "reset":
      return initialTranscribeState;
    default: {
      if (action.opId !== state.opId || state.opId === 0) return state;
      const phase = phaseFor(state, action);
      return phase === null ? state : { ...state, phase };
    }
  }
}

/** Идёт ли операция (для блокировки ввода и кнопки «Отмена»). */
export function isBusy(phase: Phase): boolean {
  return phase.name === "extracting" || phase.name === "uploading" || phase.name === "transcribing";
}
