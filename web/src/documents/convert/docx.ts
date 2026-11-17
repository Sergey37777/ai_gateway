/**
 * DOCX → Markdown (этап 6.2): mammoth даёт семантический HTML (заголовки по стилям, списки,
 * таблицы, сноски), дальше hast → mdast → GFM. Картинки выбрасываются: текст документа
 * хранится в одной колонке, data-URL ему не место. Модуль грузится лениво.
 */

import type { Element, ElementContent, Root as HastRoot } from "hast";
import { defaultHandlers, toMdast, type Handle } from "hast-util-to-mdast";
import mammoth from "mammoth";
import type { FootnoteDefinition, Root as MdastRoot } from "mdast";
import rehypeParse from "rehype-parse";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import type { Converted } from "./result";

const NOTE_LINK = /^#(footnote|endnote)-(\d+)$/u;
const NOTE_BACKLINK = /^#(footnote|endnote)-ref-\d+$/u;
const NOTE_ITEM = /^(footnote|endnote)-(\d+)$/u;

function noteId(kind: string, number: string): string {
  return `${kind === "footnote" ? "fn" : "en"}-${number}`;
}

function isElement(node: ElementContent | undefined): node is Element {
  return node?.type === "element";
}

function property(node: Element, name: string): string {
  const value = node.properties[name];
  return typeof value === "string" ? value : "";
}

/** Чистка HTML mammoth до перевода в Markdown (мутирует дерево). */
function tidy(parent: HastRoot | Element): void {
  const next: (typeof parent.children)[number][] = [];
  for (const child of parent.children) {
    if (child.type !== "element") {
      next.push(child);
      continue;
    }
    if (child.tagName === "img") continue;
    if (child.tagName === "a" && NOTE_BACKLINK.test(property(child, "href"))) {
      // стрелка «↑» из сноски обратно к тексту; пробел перед ней тоже не нужен
      const before = next.at(-1);
      if (before?.type === "text") before.value = before.value.trimEnd();
      continue;
    }
    tidy(child);
    // закладки mammoth (`<a id="_Toc…">`) — без ссылки, остаётся только текст
    if (child.tagName === "a" && property(child, "href") === "") {
      next.push(...child.children);
      continue;
    }
    if (child.tagName === "table") promoteHeaderRow(child);
    next.push(child);
  }
  parent.children = next as typeof parent.children;
}

/** У таблиц mammoth нет `th`: первая строка становится шапкой, иначе GFM даст пустую. */
function promoteHeaderRow(table: Element): void {
  const rows: Element[] = [];
  const collect = (node: Element) => {
    for (const child of node.children) {
      if (!isElement(child)) continue;
      if (child.tagName === "tr") rows.push(child);
      else if (child.tagName === "tbody" || child.tagName === "thead") collect(child);
    }
  };
  collect(table);
  const first = rows[0];
  if (first === undefined) return;
  const cells = first.children.filter(isElement);
  if (cells.some((cell) => cell.tagName === "th")) return;
  for (const cell of cells) if (cell.tagName === "td") cell.tagName = "th";
}

/** `<sup><a href="#footnote-1">[1]</a></sup>` → `[^fn-1]`. */
const sup: Handle = (state, node) => {
  const links = node.children.filter(isElement);
  const link = links.length === 1 ? links[0] : undefined;
  const match = link === undefined ? null : NOTE_LINK.exec(property(link, "href"));
  if (match === null) return state.all(node);
  const id = noteId(match[1] ?? "", match[2] ?? "");
  return { type: "footnoteReference", identifier: id, label: id };
};

/** Список сносок в конце документа → определения GFM-сносок. */
const ol: Handle = (state, node) => {
  const items = node.children.filter(isElement);
  const notes = items.map((item) => NOTE_ITEM.exec(property(item, "id")));
  if (items.length === 0 || notes.some((note) => note === null)) {
    return defaultHandlers.ol(state, node);
  }
  return items.map((item, index): FootnoteDefinition => {
    const note = notes[index];
    const id = noteId(note?.[1] ?? "", note?.[2] ?? "");
    return {
      type: "footnoteDefinition",
      identifier: id,
      label: id,
      children: state.toFlow(state.all(item)),
    };
  });
};

/** HTML mammoth → Markdown (GFM). Отдельно — ради тестов на HTML. */
export function htmlToMarkdown(html: string): string {
  const hast = unified().use(rehypeParse, { fragment: true }).parse(html);
  tidy(hast);
  const tree = toMdast(hast, { handlers: { sup, ol } });
  const mdast: MdastRoot = tree.type === "root" ? tree : { type: "root", children: [tree] };
  return unified()
    .use(remarkGfm)
    .use(remarkStringify, { bullet: "-", emphasis: "*", strong: "*", fences: true, rule: "-" })
    .stringify(mdast);
}

export async function convertDocx(bytes: Uint8Array): Promise<Converted> {
  const arrayBuffer = bytes.slice().buffer;
  // браузерная сборка mammoth читает `arrayBuffer`, Node-сборка (Vitest) — `buffer`;
  // обе принимают ArrayBuffer
  const input = Object.assign({ arrayBuffer }, { buffer: arrayBuffer });
  let html: string;
  try {
    const result = await mammoth.convertToHtml(input, {
      convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: "" })),
    });
    html = result.value;
  } catch {
    return { ok: false, message: "Не удалось прочитать DOCX" };
  }
  const markdown = htmlToMarkdown(html);
  if (markdown.trim() === "") return { ok: false, message: "В документе нет текста" };
  return { ok: true, markdown, title: null };
}
