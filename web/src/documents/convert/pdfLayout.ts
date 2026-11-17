/**
 * Раскладка текста PDF в Markdown (этап 6.2): строки → колонки → абзацы, заголовки по кеглю,
 * без колонтитулов и переносов. Чистая функция над элементами текста — pdf.js подключает `pdf.ts`.
 */

export interface PdfTextItem {
  str: string;
  /** Левый край и базовая линия в координатах PDF (y растёт вверх). */
  x: number;
  y: number;
  width: number;
  /** Кегль. */
  size: number;
  bold: boolean;
}

export interface PdfPage {
  width: number;
  height: number;
  items: PdfTextItem[];
}

export interface PdfLayout {
  markdown: string;
  /** Самый крупный заголовок первой страницы — запасное название документа. */
  heading: string | null;
}

type Column = "left" | "right" | "full";

interface Fragment {
  text: string;
  minX: number;
  maxX: number;
  y: number;
  size: number;
  bold: boolean;
  page: number;
  column: Column;
  /** Левый край потока (колонки), к которому меряется отступ. */
  left: number;
}

type Block =
  | { kind: "heading"; level: number; size: number; text: string }
  | { kind: "para"; text: string }
  | { kind: "item"; text: string };

/** Полосы колонтитулов — доля высоты страницы сверху и снизу. */
const MARGIN_BAND = 0.08;
const HEADING_RATIO = 1.15;
const MAX_HEADING_CHARS = 120;
const MAX_BOLD_HEADING_CHARS = 80;
const PARAGRAPH_GAP = 1.4;
const BULLET = /^[•◦▪·–-]\s+/u;
const PAGE_NUMBER = /^\d+(\s*(\/|из|of)\s*\d+)?$/iu;

function roundSize(size: number): number {
  return Math.round(size * 2) / 2;
}

/** Элементы страницы → фрагменты строк; межколоночный зазор разрывает строку. */
function fragments(page: PdfPage, index: number): Omit<Fragment, "column" | "left">[] {
  const items = page.items
    .filter((item) => item.str.trim() !== "")
    .toSorted((a, b) => b.y - a.y || a.x - b.x);
  const lines: PdfTextItem[][] = [];
  for (const item of items) {
    const line = lines.at(-1);
    const base = line?.[0];
    if (
      line !== undefined &&
      base !== undefined &&
      Math.abs(base.y - item.y) <= 0.5 * Math.max(base.size, item.size)
    ) {
      line.push(item);
    } else {
      lines.push([item]);
    }
  }
  const result: Omit<Fragment, "column" | "left">[] = [];
  for (const line of lines) {
    let current: PdfTextItem[] = [];
    const flush = () => {
      const first = current[0];
      if (first === undefined) return;
      let text = "";
      let end = first.x;
      for (const part of current) {
        const gap = part.x - end;
        if (
          text !== "" &&
          gap > 0.15 * part.size &&
          !text.endsWith(" ") &&
          !part.str.startsWith(" ")
        ) {
          text += " ";
        }
        text += part.str;
        end = part.x + part.width;
      }
      result.push({
        text: text.replace(/\s+/gu, " ").trim(),
        minX: first.x,
        maxX: end,
        y: first.y,
        size: Math.max(...current.map((part) => part.size)),
        bold: current.every((part) => part.bold),
        page: index,
      });
      current = [];
    };
    for (const item of line.toSorted((a, b) => a.x - b.x)) {
      const last = current.at(-1);
      if (last !== undefined && item.x - (last.x + last.width) > 2 * item.size) flush();
      current.push(item);
    }
    flush();
  }
  return result;
}

/** Ключ колонтитула: номера страниц и годы не мешают узнать повтор. */
function runningKey(text: string): string {
  return text.replace(/\d+/gu, "#");
}

/** Повторяющиеся колонтитулы и номера страниц в верхней/нижней полосе. */
function dropRunningLines(
  pages: PdfPage[],
  all: Omit<Fragment, "column" | "left">[][],
): Omit<Fragment, "column" | "left">[][] {
  if (pages.length < 3) return all;
  const inBand = (fragment: Omit<Fragment, "column" | "left">) => {
    const height = pages[fragment.page]?.height ?? 0;
    return fragment.y > height * (1 - MARGIN_BAND) || fragment.y < height * MARGIN_BAND;
  };
  const seen = new Map<string, Set<number>>();
  for (const fragment of all.flat()) {
    if (!inBand(fragment)) continue;
    const pagesWith = seen.get(runningKey(fragment.text)) ?? new Set<number>();
    pagesWith.add(fragment.page);
    seen.set(runningKey(fragment.text), pagesWith);
  }
  const threshold = Math.ceil(pages.length / 2);
  return all.map((page) =>
    page.filter(
      (fragment) =>
        !inBand(fragment) ||
        (!PAGE_NUMBER.test(fragment.text) &&
          (seen.get(runningKey(fragment.text))?.size ?? 0) < threshold),
    ),
  );
}

/** Порядок чтения страницы: шапка во всю ширину, левая колонка, правая, остальное. */
function order(page: PdfPage, items: Omit<Fragment, "column" | "left">[]): Fragment[] {
  const columnOf = (fragment: Omit<Fragment, "column" | "left">): Column => {
    if (fragment.maxX <= 0.52 * page.width) return "left";
    if (fragment.minX >= 0.48 * page.width) return "right";
    return "full";
  };
  const tagged = items.map((fragment) => ({ ...fragment, column: columnOf(fragment), left: 0 }));
  const byY = (a: Fragment, b: Fragment) => b.y - a.y;
  const left = tagged.filter((fragment) => fragment.column === "left");
  const right = tagged.filter((fragment) => fragment.column === "right");
  let sequence: Fragment[];
  if (left.length >= 3 && right.length >= 3) {
    const top = Math.max(...left.map((f) => f.y), ...right.map((f) => f.y));
    const full = tagged.filter((fragment) => fragment.column === "full").toSorted(byY);
    sequence = [
      ...full.filter((fragment) => fragment.y > top),
      ...left.toSorted(byY),
      ...right.toSorted(byY),
      ...full.filter((fragment) => fragment.y <= top),
    ];
  } else {
    for (const fragment of tagged) fragment.column = "full";
    sequence = tagged.toSorted(byY);
  }
  for (const column of ["left", "right", "full"] as const) {
    const members = sequence.filter((fragment) => fragment.column === column);
    const edge = Math.min(...members.map((fragment) => fragment.minX));
    for (const fragment of members) fragment.left = edge;
  }
  return sequence;
}

/** Самый частый кегль по числу знаков. */
function bodySize(sequence: Fragment[]): number {
  const counts = new Map<number, number>();
  for (const fragment of sequence) {
    const size = roundSize(fragment.size);
    counts.set(size, (counts.get(size) ?? 0) + fragment.text.length);
  }
  let best = 0;
  let bestCount = -1;
  for (const [size, count] of counts) {
    if (count > bestCount) {
      best = size;
      bestCount = count;
    }
  }
  return best;
}

function sameFlow(a: Fragment, b: Fragment): boolean {
  return a.page === b.page && a.column === b.column;
}

/** Обычный межстрочный шаг: медиана небольших шагов между строками основного кегля. */
function lineStep(sequence: Fragment[], body: number): number {
  const steps: number[] = [];
  for (let index = 1; index < sequence.length; index += 1) {
    const prev = sequence[index - 1];
    const cur = sequence[index];
    if (prev === undefined || cur === undefined || !sameFlow(prev, cur)) continue;
    if (roundSize(prev.size) !== body || roundSize(cur.size) !== body) continue;
    const step = prev.y - cur.y;
    if (step > 0 && step <= 2 * body) steps.push(step);
  }
  if (steps.length === 0) return 1.2 * body;
  const sorted = steps.toSorted((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 1.2 * body;
}

function joinText(a: string, b: string): string {
  if (/\p{L}-$/u.test(a) && /^\p{Ll}/u.test(b)) return a.slice(0, -1) + b;
  return `${a} ${b}`;
}

function escapeInline(text: string): string {
  return text.replace(/[\\`*_[\]<$]/gu, (char) => `\\${char}`);
}

function escapeStart(text: string): string {
  return /^[#>+=|-]/u.test(text) ? `\\${text}` : text;
}

export function layoutPdf(pages: PdfPage[]): PdfLayout {
  const raw = dropRunningLines(
    pages,
    pages.map((page, index) => fragments(page, index)),
  );
  const sequence = pages.flatMap((page, index) => order(page, raw[index] ?? []));
  if (sequence.length === 0) return { markdown: "", heading: null };

  const body = bodySize(sequence);
  const step = lineStep(sequence, body);
  const isSizeHeading = (fragment: Fragment) =>
    fragment.size >= HEADING_RATIO * body &&
    fragment.text.length <= MAX_HEADING_CHARS &&
    !fragment.text.endsWith(".");
  const headingSizes = [
    ...new Set(sequence.filter(isSizeHeading).map((fragment) => roundSize(fragment.size))),
  ].toSorted((a, b) => b - a);
  const sizeLevel = (size: number) => Math.min(3, headingSizes.indexOf(roundSize(size)) + 1);
  const boldLevel = Math.min(3, headingSizes.length + 1);

  const blocks: Block[] = [];
  /** В какой заголовок вошёл фрагмент — для названия документа. */
  const headingOf = new Map<Fragment, Block>();
  let prev: Fragment | undefined;
  for (const cur of sequence) {
    const last = blocks.at(-1);
    let gapBreak = prev === undefined;
    let styleBreak = false;
    if (prev !== undefined) {
      if (sameFlow(prev, cur)) {
        const dy = prev.y - cur.y;
        gapBreak = dy > PARAGRAPH_GAP * step;
      }
      styleBreak =
        Math.abs(prev.size - cur.size) > 0.5 ||
        (last?.kind !== "item" && cur.minX - cur.left > 1.5 * cur.size);
    }
    const broken = gapBreak || styleBreak || last?.kind === "heading";

    if (isSizeHeading(cur)) {
      const level = sizeLevel(cur.size);
      if (
        last?.kind === "heading" &&
        last.level === level &&
        !gapBreak &&
        last.size === roundSize(cur.size)
      ) {
        last.text = joinText(last.text, cur.text);
        headingOf.set(cur, last);
      } else {
        const block: Block = { kind: "heading", level, size: roundSize(cur.size), text: cur.text };
        blocks.push(block);
        headingOf.set(cur, block);
      }
    } else if (
      cur.bold &&
      roundSize(cur.size) === body &&
      cur.text.length <= MAX_BOLD_HEADING_CHARS &&
      !cur.text.endsWith(".") &&
      (gapBreak || last?.kind === "heading") &&
      !BULLET.test(cur.text)
    ) {
      blocks.push({ kind: "heading", level: boldLevel, size: body, text: cur.text });
    } else if (BULLET.test(cur.text)) {
      blocks.push({ kind: "item", text: cur.text.replace(BULLET, "") });
    } else if (!broken && (last?.kind === "para" || last?.kind === "item")) {
      last.text = joinText(last.text, cur.text);
    } else {
      blocks.push({ kind: "para", text: cur.text });
    }
    prev = cur;
  }

  let markdown = "";
  for (const [index, block] of blocks.entries()) {
    if (index > 0) {
      markdown += block.kind === "item" && blocks[index - 1]?.kind === "item" ? "\n" : "\n\n";
    }
    if (block.kind === "heading")
      markdown += `${"#".repeat(block.level)} ${escapeInline(block.text)}`;
    else if (block.kind === "item") markdown += `- ${escapeInline(block.text)}`;
    else markdown += escapeStart(escapeInline(block.text));
  }

  const top = sequence
    .filter((fragment) => fragment.page === 0 && headingOf.has(fragment))
    .toSorted((a, b) => b.size - a.size)[0];
  const heading = top === undefined ? null : (headingOf.get(top)?.text ?? null);
  return { markdown: markdown === "" ? "" : `${markdown}\n`, heading };
}
