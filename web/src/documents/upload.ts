/**
 * Подготовка файла к загрузке: проверка размера и кодировки, переводы строк, формат.
 * PDF и DOCX (этап 6.2) конвертируются в Markdown — конвертеры грузятся лениво.
 */

import type { DocumentFormat } from "../api/types";
import { MAX_ARCHIVE_MB } from "./archive";
import type { Converted } from "./convert/result";

export const ACCEPT =
  ".md,.markdown,.txt,text/markdown,text/plain," +
  ".pdf,.docx,application/pdf," +
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document," +
  ".zip,.tar,.tgz,.gz,application/zip,application/x-tar,application/gzip";

const MB = 1024 * 1024;
/** Исходный PDF/DOCX обычно много больше своего текста — у него лимит архива. */
const MAX_BINARY_MB = MAX_ARCHIVE_MB;
const TEXT_EXTENSIONS: Record<string, DocumentFormat> = {
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
};
const BINARY_EXTENSIONS = { ".pdf": "PDF", ".docx": "DOCX" } as const;
type BinaryExtension = keyof typeof BINARY_EXTENSIONS;

const UNSUPPORTED = "Поддерживаются .md, .markdown, .txt, .pdf и .docx";
const OLD_WORD = "Старый формат .doc не поддерживается — сохраните как .docx";

export type Prepared =
  | { ok: true; title: string; filename: string; format: DocumentFormat; text: string }
  | { ok: false; name: string; message: string };

function split(name: string): { base: string; extension: string } {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return { base: name, extension: "" };
  return { base: name.slice(0, dot), extension: name.slice(dot).toLowerCase() };
}

function isBinaryExtension(extension: string): extension is BinaryExtension {
  return extension in BINARY_EXTENSIONS;
}

/** Поддерживаемый файл (по расширению имени или пути): текст, PDF или DOCX. */
export function isSupportedName(name: string): boolean {
  const { extension } = split(name);
  return extension in TEXT_EXTENSIONS || isBinaryExtension(extension);
}

function titleFrom(base: string): string {
  return base.trim() === "" ? "Без названия" : base.trim();
}

/** Ошибка по расширению или `null`, если файл поддерживается. */
function extensionError(extension: string): string | null {
  if (extension === ".doc") return OLD_WORD;
  return extension in TEXT_EXTENSIONS || isBinaryExtension(extension) ? null : UNSUPPORTED;
}

/**
 * Байты текстового файла → документ для `POST /api/documents`; ошибка — понятным текстом.
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
  const format = TEXT_EXTENSIONS[extension];
  if (format === undefined) return fail(extensionError(extension) ?? UNSUPPORTED);
  if (bytes.length > maxMb * MB) return fail(`Файл больше ${String(maxMb)} МБ`);
  let decoded: string;
  try {
    // BOM TextDecoder снимает сам
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("Файл не в UTF-8");
  }
  if (decoded.includes("\u0000")) return fail("Похоже на двоичный файл");
  return {
    ok: true,
    title: title ?? titleFrom(base),
    filename: name,
    format,
    text: decoded.replace(/\r\n?/g, "\n"),
  };
}

async function convert(extension: BinaryExtension, bytes: Uint8Array): Promise<Converted> {
  try {
    if (extension === ".pdf") {
      const { convertPdf } = await import("./convert/pdf");
      return await convertPdf(bytes);
    }
    const { convertDocx } = await import("./convert/docx");
    return await convertDocx(bytes);
  } catch {
    return { ok: false, message: `Не удалось прочитать ${BINARY_EXTENSIONS[extension]}` };
  }
}

/**
 * Байты любого поддерживаемого файла → документ. PDF/DOCX становятся Markdown с именем `.md`;
 * явный `title` (путь в архиве) важнее названия из самого файла.
 */
export async function prepareBytes(
  name: string,
  bytes: Uint8Array,
  maxMb: number,
  title?: string,
): Promise<Prepared> {
  const { base, extension } = split(name);
  if (!isBinaryExtension(extension)) return prepareText(name, bytes, maxMb, title);
  const fail = (message: string): Prepared => ({ ok: false, name, message });
  if (bytes.length > MAX_BINARY_MB * MB) return fail(`Файл больше ${String(MAX_BINARY_MB)} МБ`);
  const converted = await convert(extension, bytes);
  if (!converted.ok) return fail(converted.message);
  if (new TextEncoder().encode(converted.markdown).length > maxMb * MB) {
    return fail(`Текст документа больше ${String(maxMb)} МБ`);
  }
  return {
    ok: true,
    title: title ?? converted.title ?? titleFrom(base),
    filename: `${base}.md`,
    format: "markdown",
    text: converted.markdown,
  };
}

/** Файл → документ: расширение и размер проверяются до чтения. */
export async function prepareFile(file: File, maxMb: number): Promise<Prepared> {
  const { extension } = split(file.name);
  const error = extensionError(extension);
  if (error !== null) return { ok: false, name: file.name, message: error };
  const limit = isBinaryExtension(extension) ? MAX_BINARY_MB : maxMb;
  if (file.size > limit * MB) {
    return { ok: false, name: file.name, message: `Файл больше ${String(limit)} МБ` };
  }
  return prepareBytes(file.name, new Uint8Array(await file.arrayBuffer()), maxMb);
}
