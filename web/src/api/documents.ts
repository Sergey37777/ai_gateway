/** Клиент документов `/api/documents…` (собственный API шлюза, этап 6). */

import { ApiError } from "./errors";
import { jsonInit, request } from "./http";
import { isRecord } from "./json";
import type {
  ApiDocument,
  DocumentFormat,
  DocumentItem,
  DocumentMeta,
  DocumentPage,
  TextWriteResult,
} from "./types";

const BASE = "/api/documents";
const FORMATS = ["markdown", "text"] as const;

export function parseDocumentMeta(value: unknown): DocumentMeta | null {
  if (!isRecord(value)) return null;
  const { id, title, filename, chars, revision } = value;
  const { question_count: questions, created_at: created, updated_at: updated } = value;
  const format: DocumentFormat | undefined = FORMATS.find((f) => f === value["format"]);
  if (
    typeof id !== "string" ||
    typeof title !== "string" ||
    typeof filename !== "string" ||
    format === undefined ||
    typeof chars !== "number" ||
    typeof revision !== "number" ||
    typeof questions !== "number" ||
    typeof created !== "string" ||
    typeof updated !== "string"
  ) {
    return null;
  }
  return {
    id,
    title,
    filename,
    format,
    chars,
    revision,
    question_count: questions,
    created_at: created,
    updated_at: updated,
  };
}

export function parseDocument(value: unknown): ApiDocument | null {
  const meta = parseDocumentMeta(value);
  if (meta === null || !isRecord(value) || typeof value["text"] !== "string") return null;
  return { ...meta, text: value["text"] };
}

function parseItem(value: unknown): DocumentItem | null {
  const meta = parseDocumentMeta(value);
  if (meta === null || !isRecord(value)) return null;
  const item: DocumentItem = meta;
  if (typeof value["snippet"] === "string") item.snippet = value["snippet"];
  return item;
}

function invalid(): ApiError {
  return new ApiError("Некорректный ответ сервера", null);
}

async function json(url: string, init?: RequestInit): Promise<unknown> {
  return JSON.parse(await (await request(url, init)).text());
}

function path(id: string): string {
  return `${BASE}/${encodeURIComponent(id)}`;
}

export async function listDocuments(
  params: { q?: string; before?: string },
  signal?: AbortSignal,
): Promise<DocumentPage> {
  const query = new URLSearchParams();
  if (params.q !== undefined && params.q !== "") query.set("q", params.q);
  if (params.before !== undefined) query.set("before", params.before);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const data = await json(`${BASE}${suffix}`, signal ? { signal } : {});
  if (!isRecord(data) || !Array.isArray(data["data"])) throw invalid();
  const next = data["next"];
  return {
    data: data["data"].map(parseItem).filter((item): item is DocumentItem => item !== null),
    next: typeof next === "string" ? next : null,
  };
}

export async function getDocument(id: string, signal?: AbortSignal): Promise<ApiDocument> {
  const document = parseDocument(await json(path(id), signal ? { signal } : {}));
  if (document === null) throw invalid();
  return document;
}

export async function createDocument(body: {
  title: string;
  filename: string;
  format: DocumentFormat;
  text: string;
}): Promise<ApiDocument> {
  const document = parseDocument(await json(BASE, jsonInit("POST", body)));
  if (document === null) throw invalid();
  return document;
}

export async function renameDocument(id: string, title: string): Promise<DocumentMeta> {
  const meta = parseDocumentMeta(await json(path(id), jsonInit("PATCH", { title })));
  if (meta === null) throw invalid();
  return meta;
}

/** Запись всего текста; `revision` — последний известный (иначе 409 `document_conflict`). */
export async function writeText(
  id: string,
  body: { revision: number; text: string },
): Promise<TextWriteResult> {
  const data = await json(`${path(id)}/text`, jsonInit("PUT", body));
  if (
    !isRecord(data) ||
    typeof data["revision"] !== "number" ||
    typeof data["updated_at"] !== "string" ||
    typeof data["chars"] !== "number"
  ) {
    throw invalid();
  }
  return { revision: data["revision"], updated_at: data["updated_at"], chars: data["chars"] };
}

export async function deleteDocument(id: string): Promise<void> {
  await request(path(id), { method: "DELETE" });
}
