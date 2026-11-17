/**
 * PDF → Markdown (этап 6.2): pdf.js извлекает текст с координатами и шрифтами,
 * раскладку делает `layoutPdf`. Модуль грузится лениво, только при загрузке PDF.
 */

import type * as PdfJs from "pdfjs-dist";
import { layoutPdf, type PdfPage, type PdfTextItem } from "./pdfLayout";
import type { Converted } from "./result";

export type PdfLib = Pick<typeof PdfJs, "getDocument">;

/** Браузерная сборка pdf.js и её worker из бандла (UI по LAN — без CDN). */
export async function loadPdfLib(): Promise<PdfLib> {
  const [lib, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  lib.GlobalWorkerOptions.workerSrc = worker.default;
  return lib;
}

const JUNK_TITLE = /^(untitled|microsoft word - .*)$|\.(pdf|docx?|tex|dvi)$/iu;

function metadataTitle(info: unknown): string | null {
  if (typeof info !== "object" || info === null || !("Title" in info)) return null;
  const title = info.Title;
  if (typeof title !== "string") return null;
  const trimmed = title.trim();
  return trimmed.length < 3 || JUNK_TITLE.test(trimmed) ? null : trimmed;
}

/** Название документа на сервере — до 200 знаков (`MAX_TITLE`). */
const MAX_TITLE = 200;

function clampTitle(title: string | null): string | null {
  if (title === null || title.length <= MAX_TITLE) return title;
  return `${title.slice(0, MAX_TITLE - 1).trimEnd()}…`;
}

function isBoldFont(font: unknown): boolean {
  if (typeof font !== "object" || font === null) return false;
  if ("bold" in font && font.bold === true) return true;
  return (
    "name" in font &&
    typeof font.name === "string" &&
    /bold|black|heavy|demi|[-,]medi(um)?(ital|italic|oblique)?$/iu.test(font.name)
  );
}

function isPasswordError(error: unknown): boolean {
  return error instanceof Error && error.name === "PasswordException";
}

type PdfDocument = Awaited<ReturnType<PdfLib["getDocument"]>["promise"]>;

async function readPage(doc: PdfDocument, number: number): Promise<PdfPage> {
  const page = await doc.getPage(number);
  const [x0, y0, x1, y1] = page.view;
  const content = await page.getTextContent();
  // после разбора операторов шрифты страницы лежат в commonObjs — оттуда берётся жирность
  await page.getOperatorList();
  const bold = new Map<string, boolean>();
  const fontBold = (name: string): boolean => {
    const known = bold.get(name);
    if (known !== undefined) return known;
    let value = false;
    try {
      value = isBoldFont(page.commonObjs.get(name));
    } catch {
      value = false;
    }
    bold.set(name, value);
    return value;
  };
  const items: PdfTextItem[] = [];
  for (const item of content.items) {
    if (!("str" in item) || item.str === "") continue;
    const [a, b, c, d, e, f] = item.transform.map(Number);
    // повёрнутый текст (подписи осей и т. п.) в поток не идёт
    if (b !== 0 || c !== 0 || a === undefined || d === undefined) continue;
    items.push({
      str: item.str,
      x: e ?? 0,
      y: f ?? 0,
      width: item.width,
      size: Math.abs(d) || item.height,
      bold: fontBold(item.fontName),
    });
  }
  page.cleanup();
  return { width: (x1 ?? 0) - (x0 ?? 0), height: (y1 ?? 0) - (y0 ?? 0), items };
}

export async function convertPdf(bytes: Uint8Array, lib?: PdfLib): Promise<Converted> {
  const pdfjs = lib ?? (await loadPdfLib());
  // pdf.js забирает буфер себе — отдаём копию
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    verbosity: 0,
    // без этого у шрифтов в commonObjs нет имени — по нему узнаётся жирное начертание
    fontExtraProperties: true,
  });
  let doc: PdfDocument;
  try {
    doc = await task.promise;
  } catch (error) {
    // не открылся — задачу (и worker) всё равно освободить
    await task.destroy();
    return {
      ok: false,
      message: isPasswordError(error) ? "PDF защищён паролем" : "Не удалось прочитать PDF",
    };
  }
  try {
    const pages: PdfPage[] = [];
    for (let number = 1; number <= doc.numPages; number += 1) {
      // страницы по одной: память — под одну страницу
      // oxlint-disable-next-line no-await-in-loop
      pages.push(await readPage(doc, number));
    }
    const layout = layoutPdf(pages);
    if (layout.markdown.trim() === "") {
      return { ok: false, message: "В PDF нет текстового слоя — похоже на скан" };
    }
    const metadata = await doc.getMetadata().catch(() => null);
    return {
      ok: true,
      markdown: layout.markdown,
      title: clampTitle(metadataTitle(metadata?.info) ?? layout.heading),
    };
  } catch {
    return { ok: false, message: "Не удалось прочитать PDF" };
  } finally {
    await task.destroy();
  }
}
