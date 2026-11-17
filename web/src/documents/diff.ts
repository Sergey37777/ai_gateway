/** Пословная разница «было → стало» для карточки правки (LCS по словам и пробелам). */

export type DiffPart = { kind: "same" | "del" | "add"; text: string };

/** Больше клеток таблицы LCS — разница не считается, показывается «было/стало» целиком. */
const MAX_CELLS = 2_000_000;

function tokens(text: string): string[] {
  return text.split(/(\s+)/).filter((token) => token !== "");
}

function push(parts: DiffPart[], kind: DiffPart["kind"], text: string): void {
  if (text === "") return;
  const last = parts.at(-1);
  if (last !== undefined && last.kind === kind) last.text += text;
  else parts.push({ kind, text });
}

export function diffWords(before: string, after: string): DiffPart[] {
  const a = tokens(before);
  const b = tokens(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const parts: DiffPart[] = [];
  push(parts, "same", a.slice(0, head).join(""));
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const n = midA.length;
  const m = midB.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) {
    push(parts, "del", midA.join(""));
    push(parts, "add", midB.join(""));
  } else {
    // lcs[i][j] — длина LCS суффиксов midA[i:] и midB[j:]
    const width = m + 1;
    const lcs = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[i * width + j] =
          midA[i] === midB[j]
            ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        push(parts, "same", midA[i] ?? "");
        i += 1;
        j += 1;
      } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
        push(parts, "del", midA[i] ?? "");
        i += 1;
      } else {
        push(parts, "add", midB[j] ?? "");
        j += 1;
      }
    }
    push(parts, "del", midA.slice(i).join(""));
    push(parts, "add", midB.slice(j).join(""));
  }
  push(parts, "same", a.slice(a.length - tail).join(""));
  return parts;
}
