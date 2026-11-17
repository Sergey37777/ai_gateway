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
  /** Шапка над колонками (авторы, аффилиации) — не заголовок по жирности. */
  header: boolean;
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "para"; text: string }
  | { kind: "item"; text: string };

/** Полосы колонтитулов — доля высоты страницы сверху и снизу. */
const MARGIN_BAND = 0.08;
const HEADING_RATIO = 1.15;
const PLAIN_HEADING_RATIO = 1.3;
const MAX_HEADING_CHARS = 120;
const MAX_BOLD_HEADING_CHARS = 80;
const PARAGRAPH_GAP = 1.4;
const BULLET = /^[•◦▪·–-]\s+/u;
/** Самый узкий межколоночный промежуток, pt. */
const MIN_GUTTER = 8;
/** Доля текста страницы, которая должна быть по каждую сторону промежутка. */
const COLUMN_SHARE = 0.2;
const PAGE_NUMBER = /^\d+(\s*(\/|из|of)\s*\d+)?$/iu;

function roundSize(size: number): number {
  return Math.round(size * 2) / 2;
}

/**
 * Межколоночный промежуток: самая широкая пустая вертикальная полоса в средней части страницы,
 * которую не пересекают узкие (колоночные) элементы, и заметная доля текста по обе стороны.
 * Порог по зазору внутри строки тут не работает: в статьях промежуток бывает уже двух кеглей.
 */
function findGutter(page: PdfPage, items: PdfTextItem[]): number | null {
  const narrow = items.filter((item) => item.width < 0.45 * page.width);
  if (narrow.length < 6) return null;
  const from = Math.floor(0.3 * page.width);
  const to = Math.ceil(0.7 * page.width);
  const cover = Array.from({ length: to - from + 1 }, () => 0);
  for (const item of narrow) {
    const start = Math.max(from, Math.ceil(item.x));
    const end = Math.min(to, Math.floor(item.x + item.width));
    for (let x = start; x <= end; x += 1) cover[x - from] = (cover[x - from] ?? 0) + 1;
  }
  const limit = Math.max(1, Math.floor(0.03 * narrow.length));
  let best: { start: number; length: number } | null = null;
  let start = -1;
  for (let index = 0; index <= cover.length; index += 1) {
    const empty = index < cover.length && (cover[index] ?? 0) <= limit;
    if (empty && start < 0) start = index;
    if (!empty && start >= 0) {
      const length = index - start;
      if (best === null || length > best.length) best = { start, length };
      start = -1;
    }
  }
  if (best === null || best.length < MIN_GUTTER) return null;
  const middle = from + best.start + best.length / 2;
  const chars = (keep: (item: PdfTextItem) => boolean) =>
    items.filter(keep).reduce((sum, item) => sum + item.str.length, 0);
  const total = chars(() => true);
  const left = chars((item) => item.x + item.width <= middle + 1);
  const right = chars((item) => item.x >= middle - 1);
  return left >= COLUMN_SHARE * total && right >= COLUMN_SHARE * total ? middle : null;
}

/** Элементы одной колонки → фрагменты строк (большой зазор внутри строки тоже разрывает её). */
function lineFragments(items: PdfTextItem[], page: number, column: Column): Fragment[] {
  const sorted = items.toSorted((a, b) => b.y - a.y || a.x - b.x);
  const lines: PdfTextItem[][] = [];
  for (const item of sorted) {
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
  const result: Fragment[] = [];
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
        page,
        column,
        header: false,
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

/** Фрагменты страницы с колонкой: при найденном промежутке — левая/правая/во всю ширину. */
function fragments(page: PdfPage, index: number): Fragment[] {
  const items = page.items.filter((item) => item.str.trim() !== "");
  const gutter = findGutter(page, items);
  if (gutter === null) return lineFragments(items, index, "full");
  const columnOf = (item: PdfTextItem): Column => {
    if (item.x + item.width <= gutter + 1) return "left";
    if (item.x >= gutter - 1) return "right";
    return "full";
  };
  return (["left", "right", "full"] as const).flatMap((column) =>
    lineFragments(
      items.filter((item) => columnOf(item) === column),
      index,
      column,
    ),
  );
}

/** Ключ колонтитула: номера страниц и годы не мешают узнать повтор. */
function runningKey(text: string): string {
  return text.replace(/\d+/gu, "#");
}

/** Номера страниц и повторяющиеся колонтитулы в верхней/нижней полосе. */
function dropRunningLines(pages: PdfPage[], all: Fragment[][]): Fragment[][] {
  const inBand = (fragment: Fragment) => {
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
  // повтор узнаётся от трёх страниц; одиночный номер страницы в полях убирается всегда
  const threshold = pages.length >= 3 ? Math.ceil(pages.length / 2) : Infinity;
  return all.map((page) =>
    page.filter(
      (fragment) =>
        !inBand(fragment) ||
        (!PAGE_NUMBER.test(fragment.text) &&
          (seen.get(runningKey(fragment.text))?.size ?? 0) < threshold),
    ),
  );
}

/**
 * Порядок чтения страницы: шапка, левая колонка, правая, остальное во всю ширину. Шапка — всё,
 * что во всю ширину выше начала текста колонок, и строки колонок заметно выше него (авторы).
 */
function order(items: Fragment[], body: number): Fragment[] {
  const byY = (a: Fragment, b: Fragment) => b.y - a.y || a.minX - b.minX;
  const columns = items.filter((fragment) => fragment.column !== "full");
  if (columns.length === 0) return items.toSorted(byY);
  const text = columns.filter((fragment) => roundSize(fragment.size) <= body + 0.5);
  const top = Math.max(...(text.length > 0 ? text : columns).map((fragment) => fragment.y));
  const isHeader = (fragment: Fragment) =>
    fragment.column === "full" ? fragment.y > top : fragment.y > top + 2 * body;
  const header = items.filter(isHeader);
  for (const fragment of header) {
    fragment.header = fragment.column !== "full";
    fragment.column = "full";
  }
  const rest = items.filter((fragment) => !header.includes(fragment));
  return [
    ...header.toSorted(byY),
    ...rest.filter((fragment) => fragment.column === "left").toSorted(byY),
    ...rest.filter((fragment) => fragment.column === "right").toSorted(byY),
    ...rest.filter((fragment) => fragment.column === "full").toSorted(byY),
  ];
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
  if (/\p{L}-$/u.test(a) && /^\p{Ll}/u.test(b)) {
    // «left-to-» + «right»: в составном слове дефис настоящий
    const word = a.slice(a.lastIndexOf(" ") + 1, -1);
    return word.includes("-") ? a + b : a.slice(0, -1) + b;
  }
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
  const body = bodySize(raw.flat());
  const sequence = pages.flatMap((_, index) => order(raw[index] ?? [], body));
  if (sequence.length === 0) return { markdown: "", heading: null };
  const step = lineStep(sequence, body);

  // проход 1: разрывы между строками и кандидаты в заголовки
  const gapBreaks = sequence.map((cur, index) => {
    const prev = sequence[index - 1];
    if (prev === undefined) return true;
    // зазор меряется в своей колонке и от текста во всю ширину к колонкам ниже (шапка →
    // «Abstract»); переход на новую колонку или страницу абзац не рвёт
    const measured = sameFlow(prev, cur) || (prev.page === cur.page && prev.column === "full");
    return measured && prev.y - cur.y > PARAGRAPH_GAP * step;
  });
  const isShortTitle = (fragment: Fragment, limit: number) =>
    fragment.text.length <= limit && !fragment.text.endsWith(".") && !BULLET.test(fragment.text);
  // не жирная строка чуть крупнее основного текста — скорее пометка, чем заголовок
  const isSizeHeading = (fragment: Fragment) =>
    fragment.size >= (fragment.bold ? HEADING_RATIO : PLAIN_HEADING_RATIO) * body &&
    isShortTitle(fragment, MAX_HEADING_CHARS);
  const candidates: boolean[] = [];
  for (const [index, cur] of sequence.entries()) {
    const bold =
      cur.bold &&
      !cur.header &&
      roundSize(cur.size) >= body &&
      isShortTitle(cur, MAX_BOLD_HEADING_CHARS) &&
      (gapBreaks[index] === true || candidates[index - 1] === true);
    candidates.push(isSizeHeading(cur) || bold);
  }
  // первый уровень задаёт самый крупный заголовок первой страницы: крупнее него дальше —
  // текст рисунков и плакатов, а не заголовки
  const firstPage = sequence.filter((fragment, index) => fragment.page === 0 && candidates[index]);
  if (firstPage.length > 0) {
    const largest = Math.max(...firstPage.map((fragment) => roundSize(fragment.size)));
    for (const [index, fragment] of sequence.entries()) {
      if (roundSize(fragment.size) > largest) candidates[index] = false;
    }
  }
  // кегль, встретившийся у заголовков один раз и не на первой странице, — подпись рисунка
  const counts = new Map<number, number>();
  for (const [index, fragment] of sequence.entries()) {
    if (candidates[index] !== true) continue;
    const size = roundSize(fragment.size);
    counts.set(size, (counts.get(size) ?? 0) + 1);
  }
  for (const [index, fragment] of sequence.entries()) {
    if (fragment.page > 0 && counts.get(roundSize(fragment.size)) === 1) candidates[index] = false;
  }
  // уровни — по убыванию кеглей всех заголовков, не глубже ###
  const headingSizes = [
    ...new Set(
      sequence.filter((_, index) => candidates[index]).map((fragment) => roundSize(fragment.size)),
    ),
  ].toSorted((a, b) => b - a);
  const levelOf = (size: number) => Math.min(3, headingSizes.indexOf(roundSize(size)) + 1);

  // проход 2: блоки
  const blocks: Block[] = [];
  /** В какой заголовок вошёл фрагмент — для названия документа. */
  const headingOf = new Map<Fragment, Block>();
  for (const [index, cur] of sequence.entries()) {
    const prev = sequence[index - 1];
    const last = blocks.at(-1);
    const gapBreak = gapBreaks[index] === true;
    const styleBreak =
      prev !== undefined &&
      (Math.abs(prev.size - cur.size) > 0.5 ||
        // красная строка — сдвиг относительно предыдущей строки той же колонки (у сдвинутого
        // целиком блока вроде аннотации все строки на одном отступе)
        (last?.kind !== "item" &&
          sameFlow(prev, cur) &&
          prev.y > cur.y &&
          cur.minX - prev.minX > 1.5 * cur.size));
    const broken = gapBreak || styleBreak || last?.kind === "heading";

    if (candidates[index] === true) {
      const level = levelOf(cur.size);
      if (last?.kind === "heading" && last.level === level && !gapBreak) {
        last.text = joinText(last.text, cur.text);
        headingOf.set(cur, last);
      } else {
        const block: Block = { kind: "heading", level, text: cur.text };
        blocks.push(block);
        headingOf.set(cur, block);
      }
    } else if (BULLET.test(cur.text)) {
      blocks.push({ kind: "item", text: cur.text.replace(BULLET, "") });
    } else if (!broken && (last?.kind === "para" || last?.kind === "item")) {
      last.text = joinText(last.text, cur.text);
    } else {
      blocks.push({ kind: "para", text: cur.text });
    }
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
