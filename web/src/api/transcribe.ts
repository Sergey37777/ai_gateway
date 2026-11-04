/** Разбор ответа распознавания `verbose_json` (история: `/api/transcriptions/{id}/result`). */

import { isRecord } from "./json";
import type { Segment, Transcription, Word } from "./types";

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
