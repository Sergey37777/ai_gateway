/** Состояние приёма файла: фазы до создания фоновой задачи и защита от событий устаревших операций. */

export type Phase =
  | { name: "idle" }
  | { name: "extracting"; progress: number | null }
  | { name: "uploading"; progress: number }
  | { name: "error"; message: string };

export interface TranscribeState {
  /** id текущей операции; 0 — операции нет (после cancel поздние события игнорируются). */
  opId: number;
  phase: Phase;
}

export type TranscribeAction =
  | { type: "start"; opId: number; source: File; extract: boolean }
  | { type: "extractProgress"; opId: number; progress: number }
  | { type: "extracted"; opId: number }
  | { type: "uploadProgress"; opId: number; progress: number }
  /** Сервер принял файл (202): дальше работает очередь, приём снова свободен. */
  | { type: "created"; opId: number }
  | { type: "fail"; opId: number; message: string }
  | { type: "cancel" };

export const initialTranscribeState: TranscribeState = {
  opId: 0,
  phase: { name: "idle" },
};

export function transcribeReducer(
  state: TranscribeState,
  action: TranscribeAction,
): TranscribeState {
  if (action.type === "start") {
    return {
      opId: action.opId,
      phase: action.extract
        ? { name: "extracting", progress: null }
        : { name: "uploading", progress: 0 },
    };
  }
  if (action.type === "cancel") return initialTranscribeState;
  if (action.opId !== state.opId || state.opId === 0) return state;
  switch (action.type) {
    case "extractProgress":
      return state.phase.name === "extracting"
        ? { ...state, phase: { name: "extracting", progress: action.progress } }
        : state;
    case "extracted":
      return { ...state, phase: { name: "uploading", progress: 0 } };
    case "uploadProgress":
      return state.phase.name === "uploading"
        ? { ...state, phase: { name: "uploading", progress: action.progress } }
        : state;
    case "created":
      return initialTranscribeState;
    case "fail":
      return { opId: 0, phase: { name: "error", message: action.message } };
  }
}

/** Идёт ли операция (для блокировки ввода и кнопки «Отмена»). */
export function isBusy(phase: Phase): boolean {
  return phase.name === "extracting" || phase.name === "uploading";
}

/**
 * Доля выполненного для волны: число — известна, `null` — идёт без оценки,
 * `undefined` — операции нет.
 */
export function progressValue(phase: Phase): number | null | undefined {
  switch (phase.name) {
    case "extracting":
    case "uploading":
      return phase.progress;
    default:
      return undefined;
  }
}
