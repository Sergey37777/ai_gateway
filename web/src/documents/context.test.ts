import { expect, test } from "vitest";
import { buildContext } from "./context";

function at(text: string, fragment: string): { start: number; end: number } {
  const start = text.indexOf(fragment);
  if (start < 0) throw new Error(`нет «${fragment}»`);
  return { start, end: start + fragment.length };
}

const filler = (word: string, n: number) => Array.from({ length: n }, () => word).join(" ");

test("маленький документ — целиком, с путём разделов, без оглавления", () => {
  const text = "# Спека\n\n## Хранилище\n\nreplace_tail в транзакции.\n";
  const context = buildContext(text, at(text, "replace_tail"), 1000);
  expect(context).toContain("Раздел: Спека › Хранилище");
  expect(context).not.toContain("Оглавление");
  expect(context).toContain(text.trim());
});

test("большой документ — раздел вокруг выделения и оглавление", () => {
  const text = [
    "# Спека",
    "## Введение",
    filler("вода", 300),
    "## Хранилище",
    "replace_tail в транзакции.",
    "## Хвост",
    filler("хвост", 300),
  ].join("\n\n");
  const context = buildContext(text, at(text, "replace_tail"), 600);
  expect(context).toContain("Раздел: Спека › Хранилище");
  expect(context).toContain(
    "Оглавление документа:\n- Спека\n  - Введение\n  - Хранилище\n  - Хвост",
  );
  expect(context).toContain("## Хранилище\n\nreplace_tail в транзакции.");
  expect(context).not.toContain("вода");
  expect(context).not.toContain("хвост хвост");
});

test("родительский раздел берётся, если помещается", () => {
  const text = [
    "# Спека",
    "## Архитектура",
    "### Модули",
    "documents.py хранит текст.",
    "### Связи",
    "диалог ссылается на документ.",
    "## Хвост",
    filler("хвост", 300),
  ].join("\n\n");
  const context = buildContext(text, at(text, "documents.py"), 400);
  expect(context).toContain("диалог ссылается на документ.");
  expect(context).not.toContain("хвост хвост");
});

test("огромный раздел — окно вокруг выделения по границам абзацев, с […]", () => {
  const paragraphs = Array.from(
    { length: 60 },
    (_, i) => `Абзац ${String(i)} ${filler("слово", 20)}`,
  );
  paragraphs[30] = "Абзац 30 ЦЕЛЬ здесь.";
  const text = ["# Один раздел", ...paragraphs].join("\n\n");
  const context = buildContext(text, at(text, "ЦЕЛЬ"), 1500);
  expect(context).toContain("Абзац 30 ЦЕЛЬ здесь.");
  expect(context).toContain("[…]");
  expect(context).not.toContain("Абзац 0 ");
  expect(context).not.toContain("Абзац 59 ");
  // обрез по границам абзацев: каждый абзац целиком
  for (const line of context.split("\n\n").filter((l) => l.startsWith("Абзац "))) {
    expect(paragraphs).toContain(line);
  }
  expect(context.length).toBeLessThan(1500 + 400);
});

test("текст без заголовков — без строки «Раздел»", () => {
  expect(buildContext("просто текст", { start: 0, end: 6 }, 100)).toBe("просто текст");
});
