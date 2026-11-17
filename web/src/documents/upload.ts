/** Подготовка файла к загрузке: проверка размера и кодировки, переводы строк, формат. */

import type { DocumentFormat } from "../api/types";

export const ACCEPT =
  ".md,.markdown,.txt,text/markdown,text/plain," +
  ".zip,.tar,.tgz,.gz,application/zip,application/x-tar,application/gzip";

const MB = 1024 * 1024;
const EXTENSIONS: Record<string, DocumentFormat> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
};

export type Prepared =
  | { ok: true; title: string; filename: string; format: DocumentFormat; text: string }
  | { ok: false; name: string; message: string };

function split(name: string): { base: string; extension: string } {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return { base: name, extension: "" };
  return { base: name.slice(0, dot), extension: name.slice(dot).toLowerCase() };
}

/** Поддерживаемый текстовый файл (по расширению имени или пути). */
export function isTextName(name: string): boolean {
  return split(name).extension in EXTENSIONS;
}

/**
 * Байты файла → документ для `POST /api/documents`; ошибка — понятным текстом.
 * `name` — имя файла с расширением, `title` — название (по умолчанию — имя без расширения).
 */
export function prepareText(
  name: string,
  bytes: Uint8Array,
  maxMb: number,
  title?: string,
): Prepared {
  const fail = (message: string): Prepared => ({ ok: false, name, message });
  const { base, extension } = split(name);
  const format = EXTENSIONS[extension];
  if (format === undefined) return fail("Поддерживаются только .md, .markdown и .txt");
  if (bytes.length > maxMb * MB) return fail(`Файл больше ${String(maxMb)} МБ`);
  let decoded: string;
  try {
    // BOM TextDecoder снимает сам
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("Файл не в UTF-8");
  }
  if (decoded.includes("\u0000")) return fail("Похоже на двоичный файл");
  const fallback = base.trim() === "" ? "Без названия" : base.trim();
  return {
    ok: true,
    title: title ?? fallback,
    filename: name,
    format,
    text: decoded.replace(/\r\n?/g, "\n"),
  };
}

/** Файл → документ: размер проверяется до чтения. */
export async function prepareFile(file: File, maxMb: number): Promise<Prepared> {
  const { extension } = split(file.name);
  if (EXTENSIONS[extension] === undefined) {
    return { ok: false, name: file.name, message: "Поддерживаются только .md, .markdown и .txt" };
  }
  if (file.size > maxMb * MB) {
    return { ok: false, name: file.name, message: `Файл больше ${String(maxMb)} МБ` };
  }
  return prepareText(file.name, new Uint8Array(await file.arrayBuffer()), maxMb);
}
