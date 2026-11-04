/** POST /v1/audio/transcriptions через XMLHttpRequest — ради прогресса загрузки (у fetch его нет). */

import { isRecord } from "./json";
import type { Segment, Transcription, Word } from "./types";
import { xhrUpload, type UploadHooks, type XhrLike } from "./xhr";

export interface TranscribeOptions {
  model: string;
  language: string | null;
}

export type TranscribeHooks = UploadHooks;
export type { XhrLike };

function parseSegment(value: unknown): Segment | null {
  if (!isRecord(value)) return null;
  const { id, start, end, text } = value;
  if (
    typeof id !== "number" ||
    typeof start !== "number" ||
    typeof end !== "number" ||
    typeof text !== "string"
  ) {
    return null;
  }
  return { id, start, end, text };
}

function parseWord(value: unknown): Word | null {
  if (!isRecord(value)) return null;
  const { word, start, end } = value;
  if (typeof word !== "string" || typeof start !== "number" || typeof end !== "number") {
    return null;
  }
  return { word, start, end };
}

/** Тело `verbose_json` → `Transcription` (`raw` — для скачивания json). */
export function parseTranscription(raw: string): Transcription {
  const data: unknown = JSON.parse(raw);
  if (!isRecord(data) || typeof data["text"] !== "string") {
    throw new Error("Некорректный ответ сервера распознавания");
  }
  const segments = Array.isArray(data["segments"]) ? data["segments"] : [];
  const words = Array.isArray(data["words"]) ? data["words"] : [];
  return {
    text: data["text"],
    language: typeof data["language"] === "string" ? data["language"] : "",
    duration: typeof data["duration"] === "number" ? data["duration"] : 0,
    segments: segments.map(parseSegment).filter((s): s is Segment => s !== null),
    words: words.map(parseWord).filter((w): w is Word => w !== null),
    raw,
  };
}

export function transcribe(
  file: File,
  options: TranscribeOptions,
  hooks: TranscribeHooks = {},
  createXhr: () => XhrLike = () => new XMLHttpRequest(),
): Promise<Transcription> {
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("model", options.model);
  if (options.language !== null) form.append("language", options.language);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");
  form.append("timestamp_granularities[]", "word");
  return xhrUpload("/v1/audio/transcriptions", form, parseTranscription, hooks, createXhr);
}
