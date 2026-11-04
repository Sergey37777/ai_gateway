/** Клиент истории распознаваний `/api/transcriptions…` (собственный API шлюза). */

import { authHeaders, notifyUnauthorized } from "./apiKey";
import { networkError, parseErrorResponse } from "./errors";
import { isRecord } from "./json";
import { parseTranscription } from "./transcribe";
import type { JobStatus, Transcription, TranscriptionJob, TranscriptionPage } from "./types";
import { xhrUpload, type UploadHooks, type XhrLike } from "./xhr";

const BASE = "/api/transcriptions";
const STATUSES: readonly JobStatus[] = ["queued", "running", "done", "failed", "cancelled"];

function isStatus(value: unknown): value is JobStatus {
  return STATUSES.some((s) => s === value);
}

function stringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function numberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function parseError(value: unknown): TranscriptionJob["error"] | undefined {
  if (value === null) return null;
  if (
    isRecord(value) &&
    typeof value["code"] === "string" &&
    typeof value["message"] === "string"
  ) {
    return { code: value["code"], message: value["message"] };
  }
  return undefined;
}

/** Объект распознавания из JSON; некорректный — `null`. */
export function parseJob(value: unknown): TranscriptionJob | null {
  if (!isRecord(value)) return null;
  const {
    id,
    status,
    source,
    title,
    filename,
    model,
    language,
    duration,
    progress,
    queue_position: queuePosition,
    has_audio: hasAudio,
    retryable,
    created_at: createdAt,
    started_at: startedAt,
    finished_at: finishedAt,
    snippet,
  } = value;
  const error = parseError(value["error"]);
  if (
    typeof id !== "string" ||
    !isStatus(status) ||
    (source !== "ui" && source !== "api") ||
    typeof title !== "string" ||
    typeof filename !== "string" ||
    typeof model !== "string" ||
    !stringOrNull(language) ||
    !numberOrNull(duration) ||
    !numberOrNull(progress) ||
    !numberOrNull(queuePosition) ||
    error === undefined ||
    typeof hasAudio !== "boolean" ||
    typeof retryable !== "boolean" ||
    typeof createdAt !== "string" ||
    !stringOrNull(startedAt) ||
    !stringOrNull(finishedAt)
  ) {
    return null;
  }
  const job: TranscriptionJob = {
    id,
    status,
    source,
    title,
    filename,
    model,
    language,
    duration,
    progress,
    queue_position: queuePosition,
    error,
    has_audio: hasAudio,
    retryable,
    created_at: createdAt,
    started_at: startedAt,
    finished_at: finishedAt,
  };
  if (typeof snippet === "string") job.snippet = snippet;
  return job;
}

function jobFromText(text: string): TranscriptionJob {
  const job = parseJob(JSON.parse(text));
  if (job === null) throw new Error("Некорректный ответ сервера истории");
  return job;
}

/** fetch с ключом; ошибки — `ApiError` (401 — запрос ключа), сеть — понятный текст. */
async function request(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(authHeaders())) headers.set(name, value);
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch (error) {
    if (isRecord(error) && error["name"] === "AbortError") throw error;
    throw networkError();
  }
  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized();
    throw parseErrorResponse(
      response.status,
      await response.text(),
      response.headers.get("Retry-After"),
    );
  }
  return response;
}

async function requestJob(url: string, init?: RequestInit): Promise<TranscriptionJob> {
  return jobFromText(await (await request(url, init)).text());
}

export interface CreateOptions {
  model: string;
  language: string | null;
  title: string | null;
}

/** Фоновое распознавание: загрузка с прогрессом (XHR), ответ 202 — запись `queued`. */
export function createTranscription(
  file: File,
  options: CreateOptions,
  hooks: UploadHooks = {},
  createXhr?: () => XhrLike,
): Promise<TranscriptionJob> {
  const form = new FormData();
  form.append("file", file, file.name);
  form.append("model", options.model);
  if (options.language !== null) form.append("language", options.language);
  if (options.title !== null) form.append("title", options.title);
  return xhrUpload(BASE, form, jobFromText, hooks, createXhr);
}

export function getTranscription(id: string, signal?: AbortSignal): Promise<TranscriptionJob> {
  return requestJob(`${BASE}/${encodeURIComponent(id)}`, signal ? { signal } : {});
}

export async function listTranscriptions(
  params: { q?: string; before?: string },
  signal?: AbortSignal,
): Promise<TranscriptionPage> {
  const query = new URLSearchParams();
  if (params.q !== undefined && params.q !== "") query.set("q", params.q);
  if (params.before !== undefined) query.set("before", params.before);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const response = await request(`${BASE}${suffix}`, signal ? { signal } : {});
  const data: unknown = JSON.parse(await response.text());
  if (!isRecord(data) || !Array.isArray(data["data"])) {
    throw new Error("Некорректный ответ сервера истории");
  }
  const next = data["next"];
  return {
    data: data["data"].map(parseJob).filter((job): job is TranscriptionJob => job !== null),
    next: typeof next === "string" ? next : null,
  };
}

/** Результат (`verbose_json`, со словами, если сохранены). */
export async function getResult(id: string): Promise<Transcription> {
  const response = await request(`${BASE}/${encodeURIComponent(id)}/result`);
  return parseTranscription(await response.text());
}

/** Аудио записи целиком: `<audio src>` не умеет заголовок `Authorization`. */
export async function getAudio(id: string): Promise<Blob> {
  return (await request(`${BASE}/${encodeURIComponent(id)}/audio`)).blob();
}

export function renameTranscription(id: string, title: string): Promise<TranscriptionJob> {
  return requestJob(`${BASE}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

export function cancelTranscription(id: string): Promise<TranscriptionJob> {
  return requestJob(`${BASE}/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

export function retryTranscription(id: string): Promise<TranscriptionJob> {
  return requestJob(`${BASE}/${encodeURIComponent(id)}/retry`, { method: "POST" });
}

export async function deleteTranscription(id: string): Promise<void> {
  await request(`${BASE}/${encodeURIComponent(id)}`, { method: "DELETE" });
}
