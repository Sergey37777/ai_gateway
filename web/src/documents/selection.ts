/** Выделение в превью → диапазон в исходнике (по `data-src-*` блоков, иначе поиск цитаты). */

interface Range {
  start: number;
  end: number;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Первое вхождение цитаты (первые 12 слов) с любыми пробелами между словами; −1 — нет. */
export function findQuote(text: string, quote: string): number {
  const words = quote.trim().split(/\s+/).filter(Boolean).slice(0, 12);
  if (words.length === 0) return -1;
  const match = new RegExp(words.map(escape).join("\\s+")).exec(text);
  return match === null ? -1 : match.index;
}

function block(node: Node | null, root: HTMLElement): HTMLElement | null {
  let current: Node | null = node;
  while (current !== null && current !== root) {
    if (current instanceof HTMLElement && current.dataset["srcStart"] !== undefined) return current;
    current = current.parentNode;
  }
  return null;
}

export function sourceRange(root: HTMLElement, selection: Selection, text: string): Range {
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    const first = block(range.startContainer, root);
    const last = block(range.endContainer, root);
    const start = Number(first?.dataset["srcStart"]);
    const end = Number(last?.dataset["srcEnd"]);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return { start, end };
  }
  const quote = selection.toString();
  const index = findQuote(text, quote);
  if (index < 0) return { start: 0, end: 0 };
  return { start: index, end: index + quote.trim().length };
}
