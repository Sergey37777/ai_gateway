/**
 * Правки документа в ответе модели (этап 6.1): блоки SEARCH/REPLACE, поиск фрагмента в документе,
 * применение и статус. Статус не хранится — он вычисляется по текущему тексту документа.
 */

export interface Edit {
  search: string;
  replace: string;
  /** Блок закрыт; `false` — модель ещё пишет его (стрим) или оборвалась. */
  complete: boolean;
}

export type Segment = { kind: "text"; text: string } | { kind: "edit"; edit: Edit };

export type EditStatus = "pending" | "applicable" | "applied" | "ambiguous" | "missing" | "noop";

export type Applied =
  { ok: true; text: string; at: number } | { ok: false; reason: "missing" | "ambiguous" };

const START = /^\s*<{5,9}(?:\s.*)?$/;
const DIVIDER = /^\s*={5,9}\s*$/;
const END = /^\s*>{5,9}(?:\s.*)?$/;
const FENCE = /^\s*```[\w-]*\s*$/;
const CLOSING_FENCE = /^\s*```\s*$/;

/** Ответ модели → текст и блоки правки (незакрытый блок в конце — `complete: false`). */
export function parseAnswer(content: string): Segment[] {
  const lines = content.split("\n");
  const segments: Segment[] = [];
  let text: string[] = [];
  let search: string[] = [];
  let replace: string[] = [];
  let state: "text" | "search" | "replace" = "text";
  // блоки внутри ограды ``` … ```: ограда снимается
  let fenced = false;

  const flushText = () => {
    const value = text.join("\n");
    if (value.trim() !== "") segments.push({ kind: "text", text: value });
    text = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (state === "text") {
      if (!START.test(line)) {
        text.push(line);
        continue;
      }
      const lastFilled = text.findLastIndex((l) => l.trim() !== "");
      const lastLine = lastFilled < 0 ? undefined : text[lastFilled];
      if (lastLine !== undefined && FENCE.test(lastLine)) {
        text = text.slice(0, lastFilled);
        fenced = true;
      } else if (lastFilled >= 0) {
        fenced = false;
      }
      flushText();
      search = [];
      replace = [];
      state = "search";
    } else if (state === "search") {
      if (DIVIDER.test(line)) state = "replace";
      else search.push(line);
    } else if (END.test(line)) {
      segments.push({
        kind: "edit",
        edit: { search: search.join("\n"), replace: replace.join("\n"), complete: true },
      });
      state = "text";
      if (fenced) {
        let next = index + 1;
        while (next < lines.length && (lines[next] ?? "").trim() === "") next += 1;
        if (next < lines.length && CLOSING_FENCE.test(lines[next] ?? "")) {
          index = next;
          fenced = false;
        }
      }
    } else {
      replace.push(line);
    }
  }

  if (state === "text") flushText();
  else {
    segments.push({
      kind: "edit",
      edit: { search: search.join("\n"), replace: replace.join("\n"), complete: false },
    });
  }
  return segments;
}

export function hasEdits(content: string): boolean {
  return parseAnswer(content).some((s) => s.kind === "edit");
}

export interface Located {
  count: number;
  start: number;
  end: number;
}

const NOT_FOUND: Located = { count: 0, start: -1, end: -1 };

function normalize(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

/** Фрагмент в тексте: точно, иначе построчно без учёта пробелов. */
export function locate(doc: string, fragment: string): Located {
  if (fragment.trim() === "") return NOT_FOUND;
  let count = 0;
  let first = -1;
  for (let at = doc.indexOf(fragment); at >= 0; at = doc.indexOf(fragment, at + 1)) {
    if (first < 0) first = at;
    count += 1;
  }
  if (count > 0) return { count, start: first, end: first + fragment.length };

  const wanted = fragment.split("\n").map(normalize);
  while (wanted[0] === "") wanted.shift();
  while (wanted.at(-1) === "") wanted.pop();
  const lines = doc.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  let found: Located = NOT_FOUND;
  for (let i = 0; i + wanted.length <= lines.length; i += 1) {
    if (!wanted.every((w, k) => normalize(lines[i + k] ?? "") === w)) continue;
    if (found.count === 0) {
      const last = i + wanted.length - 1;
      found = {
        count: 1,
        start: starts[i] ?? 0,
        end: (starts[last] ?? 0) + (lines[last] ?? "").length,
      };
    } else {
      found = { ...found, count: found.count + 1 };
    }
  }
  return found;
}

function trimNewlines(value: string): string {
  return value.replace(/^\n+|\n+$/g, "");
}

export function applyEdit(doc: string, edit: Pick<Edit, "search" | "replace">): Applied {
  if (edit.search.trim() === "") {
    const base = doc.replace(/\s+$/, "");
    const addition = trimNewlines(edit.replace);
    if (base === "") return { ok: true, text: `${addition}\n`, at: 0 };
    return { ok: true, text: `${base}\n\n${addition}\n`, at: base.length + 2 };
  }
  const found = locate(doc, edit.search);
  if (found.count === 0) return { ok: false, reason: "missing" };
  if (found.count > 1) return { ok: false, reason: "ambiguous" };
  return {
    ok: true,
    text: doc.slice(0, found.start) + edit.replace + doc.slice(found.end),
    at: found.start,
  };
}

/** Обратная правка: REPLACE снова становится SEARCH (дописанное в конец — убирается). */
export function revertEdit(doc: string, edit: Pick<Edit, "search" | "replace">): Applied {
  if (edit.search.trim() === "") {
    const found = locate(doc, trimNewlines(edit.replace));
    if (found.count !== 1) return { ok: false, reason: found.count > 1 ? "ambiguous" : "missing" };
    const before = doc.slice(0, found.start).replace(/\s+$/, "");
    const after = doc.slice(found.end).replace(/^\s+/, "");
    const text = [before, after].filter((part) => part !== "").join("\n\n");
    return { ok: true, text: text === "" ? "" : `${text}\n`, at: before.length };
  }
  if (edit.replace.trim() === "") return { ok: false, reason: "missing" };
  return applyEdit(doc, { search: edit.replace, replace: edit.search });
}

export function editStatus(doc: string, edit: Edit): EditStatus {
  if (!edit.complete) return "pending";
  if (edit.search.trim() === "") {
    if (edit.replace.trim() === "") return "noop";
    return locate(doc, trimNewlines(edit.replace)).count > 0 ? "applied" : "applicable";
  }
  if (edit.search === edit.replace) return "noop";
  const search = locate(doc, edit.search);
  const replaced = edit.replace.trim() === "" ? 0 : locate(doc, edit.replace).count;
  // SEARCH внутри REPLACE (дописали после фрагмента): после применения SEARCH всё ещё находится
  if (replaced > 0 && locate(edit.replace, edit.search).count > 0) return "applied";
  if (search.count === 1) return "applicable";
  if (search.count > 1) return "ambiguous";
  return replaced > 0 ? "applied" : "missing";
}
