/**
 * Контекст документа для вопроса модели (спецификация этапа 6, §7.6): весь документ, если
 * помещается в бюджет; иначе — раздел вокруг выделения (с подъёмом к родителю, пока помещается)
 * или окно по границам блоков. Плюс путь разделов и оглавление.
 */

import { outline, parseMarkdown, type Heading } from "./outline";

/** ≈ 6–8 тыс. токенов gemma для русского текста при окне Ollama 16 384. */
export const CONTEXT_BUDGET = 24_000;
const OUTLINE_LIMIT = 2000;
const CUT = "[…]";

interface Range {
  start: number;
  end: number;
}

interface Section {
  heading: Heading;
  start: number;
  end: number;
}

function sections(text: string, headings: Heading[]): Section[] {
  return headings.map((heading, index) => {
    const next = headings.slice(index + 1).find((h) => h.depth <= heading.depth);
    return { heading, start: heading.start, end: next?.start ?? text.length };
  });
}

function outlineText(headings: Heading[]): string {
  const lines = headings
    .filter((h) => h.depth <= 3)
    .map((h) => `${"  ".repeat(h.depth - 1)}- ${h.text}`);
  let result = "Оглавление документа:";
  for (const line of lines) {
    if (result.length + line.length + 1 > OUTLINE_LIMIT) break;
    result += `\n${line}`;
  }
  return result;
}

/** Окно `budget` вокруг выделения; границы — по блокам верхнего уровня, если получается. */
function windowAround(text: string, range: Range, budget: number): string {
  const blocks = parseMarkdown(text)
    .children.map((node) => ({
      start: node.position?.start.offset ?? 0,
      end: node.position?.end.offset ?? 0,
    }))
    .filter((block) => block.end > block.start);
  const center = Math.floor((range.start + range.end) / 2);
  let from = Math.max(0, center - Math.floor(budget / 2));
  let to = Math.min(text.length, from + budget);
  from = Math.max(0, to - budget);
  // начало — первый блок, целиком лежащий в окне (но не позже начала выделения)
  const first = blocks.find((b) => b.start >= from && b.start <= range.start);
  // конец — последний блок, целиком лежащий в окне (но не раньше конца выделения)
  const last = blocks.findLast((b) => b.end <= to && b.end >= range.end);
  if (first !== undefined) from = first.start;
  if (last !== undefined) to = last.end;
  const body = text.slice(from, to).trim();
  return `${from > 0 ? `${CUT}\n\n` : ""}${body}${to < text.length ? `\n\n${CUT}` : ""}`;
}

export function buildContext(text: string, range: Range, budget = CONTEXT_BUDGET): string {
  const headings = outline(text);
  const containing = sections(text, headings).filter(
    (s) => s.start <= range.start && range.start < s.end,
  );
  const parts: string[] = [];
  if (containing.length > 0) {
    parts.push(`Раздел: ${containing.map((s) => s.heading.text).join(" › ")}`);
  }
  if (text.length <= budget) {
    parts.push(text.trim());
    return parts.join("\n\n");
  }
  parts.push(outlineText(headings));
  // самый внешний раздел, который помещается: от глубокого к родителю, пока влезает
  const fitting = containing.find((s) => s.end - s.start <= budget);
  const body =
    fitting === undefined
      ? windowAround(text, range, budget)
      : text.slice(fitting.start, fitting.end).trim();
  parts.push(`---\n\n${body}`);
  return parts.join("\n\n");
}
