/** Подготовка файла к загрузке: проверка размера и кодировки, переводы строк, формат. */

import type { DocumentFormat } from "../api/types";

export const ACCEPT = ".md,.markdown,.txt,text/markdown,text/plain";

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

/** Файл → документ для `POST /api/documents`; ошибка — понятным текстом. */
export async function prepareFile(file: File, maxMb: number): Promise<Prepared> {
  const fail = (message: string): Prepared => ({ ok: false, name: file.name, message });
  const { base, extension } = split(file.name);
  const format = EXTENSIONS[extension];
  if (format === undefined) return fail("Поддерживаются только .md, .markdown и .txt");
  if (file.size > maxMb * MB) return fail(`Файл больше ${String(maxMb)} МБ`);
  let decoded: string;
  try {
    // BOM TextDecoder снимает сам
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    return fail("Файл не в UTF-8");
  }
  if (decoded.includes("\u0000")) return fail("Похоже на двоичный файл");
  const title = base.trim() === "" ? "Без названия" : base.trim();
  return {
    ok: true,
    title,
    filename: file.name,
    format,
    text: decoded.replace(/\r\n?/g, "\n"),
  };
}
