/** POST /v1/audio/transcriptions через XMLHttpRequest — ради прогресса загрузки (у fetch его нет). */

import { authHeaders, notifyUnauthorized } from "./apiKey";
import { networkError, parseErrorResponse } from "./errors";
import { isRecord } from "./json";
import type { Segment, Transcription, Word } from "./types";

export interface TranscribeOptions {
  model: string;
  language: string | null;
}

export interface TranscribeHooks {
  onUploadProgress?: (fraction: number) => void;
  /** Файл загружен целиком — дальше сервер распознаёт. */
  onUploaded?: () => void;
  signal?: AbortSignal;
}

interface ProgressTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
}

/** Часть XMLHttpRequest, которой пользуется модуль (для подмены в тестах). */
export interface XhrLike extends ProgressTarget {
  readonly status: number;
  readonly responseText: string;
  readonly upload: ProgressTarget;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  getResponseHeader(name: string): string | null;
  send(body: FormData): void;
  abort(): void;
}

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

function parseTranscription(raw: string): Transcription {
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
  return new Promise((resolve, reject) => {
    const xhr = createXhr();
    const form = new FormData();
    form.append("file", file, file.name);
    form.append("model", options.model);
    if (options.language !== null) form.append("language", options.language);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    form.append("timestamp_granularities[]", "word");

    const onAbortSignal = () => {
      xhr.abort();
    };
    const cleanup = () => {
      hooks.signal?.removeEventListener("abort", onAbortSignal);
    };

    xhr.upload.addEventListener("progress", (event) => {
      if (event instanceof ProgressEvent && event.lengthComputable && event.total > 0) {
        hooks.onUploadProgress?.(event.loaded / event.total);
      }
    });
    xhr.upload.addEventListener("load", () => {
      hooks.onUploaded?.();
    });
    xhr.addEventListener("load", () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(parseTranscription(xhr.responseText));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      if (xhr.status === 401) notifyUnauthorized();
      reject(
        parseErrorResponse(xhr.status, xhr.responseText, xhr.getResponseHeader("Retry-After")),
      );
    });
    xhr.addEventListener("error", () => {
      cleanup();
      reject(networkError());
    });
    xhr.addEventListener("abort", () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    });

    if (hooks.signal?.aborted === true) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    hooks.signal?.addEventListener("abort", onAbortSignal);
    xhr.open("POST", "/v1/audio/transcriptions");
    for (const [name, value] of Object.entries(authHeaders())) xhr.setRequestHeader(name, value);
    // без таймаута: распознавание часа аудио на GPU занимает минуты
    xhr.send(form);
  });
}
