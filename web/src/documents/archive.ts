/**
 * Распаковка архивов в браузере (этап 6.1): zip, tar, tar.gz. Наружу — только файлы, которые
 * подходят под `accept`; мусор (каталоги, `__MACOSX/`, скрытые файлы) отбрасывается молча.
 */

import { gunzipSync, unzipSync } from "fflate";

export const MAX_ARCHIVE_MB = 200;
export const MAX_ARCHIVE_DOCUMENTS = 500;
/** Распакованный tar из .tar.gz — не больше (защита от «бомб»). */
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;

const ARCHIVE_NAME = /\.(zip|tar|tgz|tar\.gz)$/i;

export function isArchiveName(name: string): boolean {
  return ARCHIVE_NAME.test(name);
}

export interface ArchiveEntry {
  path: string;
  data: Uint8Array;
}

export interface ExtractOptions {
  /** Нужен ли файл (по пути внутри архива). */
  accept: (path: string) => boolean;
  /** Файлы больше — не распаковываются, попадают в `oversized`. */
  maxEntryBytes: number;
}

export type Extracted =
  | { ok: true; entries: ArchiveEntry[]; oversized: string[]; skipped: string[] }
  | { ok: false; message: string };

class ArchiveError extends Error {}

/** Каталог, служебные файлы macOS, скрытые файлы и папки. */
function isJunk(path: string): boolean {
  if (path.endsWith("/")) return true;
  return path.split("/").some((part) => part.startsWith(".") || part === "__MACOSX");
}

function clean(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.?\/+/, "");
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const utf8 = new TextDecoder("utf-8");
const cp866 = new TextDecoder("ibm866");

/**
 * Имя из zip без флага UTF-8: fflate отдаёт его как latin1 (байт = символ). Байты — это UTF-8
 * (macOS, 7-Zip) или CP866 (Проводник Windows с кириллицей).
 */
function zipName(name: string): string {
  const codes = Array.from({ length: name.length }, (_, index) => name.charCodeAt(index));
  if (codes.some((code) => code > 0xff) || codes.every((code) => code < 0x80)) return name;
  const bytes = Uint8Array.from(codes);
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return cp866.decode(bytes);
  }
}

function startsWith(data: Uint8Array, bytes: number[], at = 0): boolean {
  return bytes.every((byte, index) => data[at + index] === byte);
}

function isZip(data: Uint8Array): boolean {
  return startsWith(data, [0x50, 0x4b, 0x03, 0x04]) || startsWith(data, [0x50, 0x4b, 0x05, 0x06]);
}

function isGzip(data: Uint8Array): boolean {
  return startsWith(data, [0x1f, 0x8b]);
}

function isTar(data: Uint8Array): boolean {
  // "ustar" на смещении 257
  return startsWith(data, [0x75, 0x73, 0x74, 0x61, 0x72], 257);
}

interface Collected {
  entries: ArchiveEntry[];
  oversized: string[];
  skipped: string[];
}

type Verdict = "junk" | "skip" | "big" | "take";

function classify(path: string, size: number, options: ExtractOptions): Verdict {
  if (path === "" || isJunk(path)) return "junk";
  if (!options.accept(path)) return "skip";
  return size > options.maxEntryBytes ? "big" : "take";
}

function extractZip(data: Uint8Array, options: ExtractOptions): Collected {
  const result: Collected = { entries: [], oversized: [], skipped: [] };
  const wanted: { raw: string; path: string }[] = [];
  const files = unzipSync(data, {
    // распаковываются только нужные записи; размер известен до распаковки
    filter: (file) => {
      const path = clean(zipName(file.name));
      const verdict = classify(path, file.originalSize, options);
      if (verdict === "skip") result.skipped.push(path);
      if (verdict === "big") result.oversized.push(path);
      if (verdict !== "take") return false;
      // сжатие кроме store/deflate fflate не умеет
      if (file.compression !== 0 && file.compression !== 8) {
        result.skipped.push(path);
        return false;
      }
      wanted.push({ raw: file.name, path });
      return true;
    },
  });
  for (const { raw, path } of wanted) {
    const content = files[raw];
    if (content === undefined) throw new ArchiveError("Архив повреждён");
    result.entries.push({ path, data: content });
  }
  return result;
}

function text(data: Uint8Array, start: number, length: number): string {
  const slice = data.subarray(start, start + length);
  const end = slice.indexOf(0);
  return utf8.decode(end < 0 ? slice : slice.subarray(0, end));
}

function tarSize(header: Uint8Array): number {
  const first = header[124] ?? 0;
  if (first & 0x80) {
    // base-256 (GNU) для больших файлов
    let size = first & 0x7f;
    for (let i = 125; i < 136; i += 1) size = size * 256 + (header[i] ?? 0);
    return size;
  }
  const octal = text(header, 124, 12).trim();
  const size = octal === "" ? 0 : Number.parseInt(octal, 8);
  if (Number.isNaN(size)) throw new ArchiveError("Архив повреждён");
  return size;
}

/** Записи pax: "<длина> <ключ>=<значение>\n". */
function paxPath(body: Uint8Array): string | null {
  let path: string | null = null;
  for (const record of utf8.decode(body).split("\n")) {
    const match = /^\d+ path=(.*)$/s.exec(record);
    if (match?.[1] !== undefined) path = match[1];
  }
  return path;
}

function extractTar(data: Uint8Array, options: ExtractOptions): Collected {
  const result: Collected = { entries: [], oversized: [], skipped: [] };
  let offset = 0;
  let longName: string | null = null;
  let pax: string | null = null;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = tarSize(header);
    const type = String.fromCharCode(header[156] ?? 0);
    const start = offset + 512;
    if (start + size > data.length) throw new ArchiveError("Архив повреждён или обрезан");
    const body = data.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pax = paxPath(body);
      continue;
    }
    if (type === "L") {
      longName = text(body, 0, body.length);
      continue;
    }
    if (type === "g") continue;
    // prefix есть только в POSIX ustar ("ustar\0"); в старом GNU ("ustar ") там другие поля
    const prefix = isTar(header) && header[262] === 0 ? text(header, 345, 155) : "";
    const name = text(header, 0, 100);
    const path = pax ?? longName ?? (prefix === "" ? name : `${prefix}/${name}`);
    pax = null;
    longName = null;
    // обычный файл: '0', '\0' или '7' (contiguous)
    if (type !== "0" && type !== "\0" && type !== "7") continue;
    const cleaned = clean(path);
    const verdict = classify(cleaned, size, options);
    if (verdict === "skip") result.skipped.push(cleaned);
    if (verdict === "big") result.oversized.push(cleaned);
    if (verdict === "take") result.entries.push({ path: cleaned, data: body });
  }
  return result;
}

function gunzip(data: Uint8Array): Uint8Array {
  // ISIZE — размер распакованного по модулю 2^32, последние 4 байта
  const tail = data.length - 4;
  const unpacked =
    ((data[tail] ?? 0) |
      ((data[tail + 1] ?? 0) << 8) |
      ((data[tail + 2] ?? 0) << 16) |
      ((data[tail + 3] ?? 0) << 24)) >>>
    0;
  if (unpacked > MAX_UNPACKED_BYTES)
    throw new ArchiveError("Архив слишком большой после распаковки");
  return gunzipSync(data);
}

export function extractArchive(data: Uint8Array, options: ExtractOptions): Extracted {
  try {
    let collected: Collected;
    if (isZip(data)) collected = extractZip(data, options);
    else if (isGzip(data)) {
      const tar = gunzip(data);
      if (!isTar(tar)) return { ok: false, message: "Внутри .gz нет tar-архива" };
      collected = extractTar(tar, options);
    } else if (isTar(data)) collected = extractTar(data, options);
    else return { ok: false, message: "Неизвестный формат архива (нужен .zip, .tar или .tar.gz)" };
    if (collected.entries.length + collected.oversized.length > MAX_ARCHIVE_DOCUMENTS) {
      return {
        ok: false,
        message: `В архиве больше ${String(MAX_ARCHIVE_DOCUMENTS)} документов — разделите его`,
      };
    }
    return { ok: true, ...collected };
  } catch (error) {
    if (error instanceof ArchiveError) return { ok: false, message: error.message };
    return { ok: false, message: "Не удалось распаковать архив — он повреждён или зашифрован" };
  }
}

/**
 * Названия документов из путей: путь без расширения, общая корневая папка срезается
 * (`docs/guide/install.md` → `guide/install`). Длинное название — с конца, в `limit` знаков.
 */
export function titlesFromPaths(paths: string[], limit = 200): string[] {
  const split = paths.map((path) => path.split("/"));
  const root = split[0]?.[0];
  const shared =
    root !== undefined && split.every((parts) => parts.length > 1 && parts[0] === root);
  return split.map((parts) => {
    const rest = shared ? parts.slice(1) : parts;
    const joined = rest.join("/");
    const dot = joined.lastIndexOf(".");
    const base = (dot > joined.lastIndexOf("/") ? joined.slice(0, dot) : joined).trim();
    const title = base === "" ? "Без названия" : base;
    return title.length > limit ? `…${title.slice(title.length - limit + 1)}` : title;
  });
}
