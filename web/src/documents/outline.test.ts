import { expect, test } from "vitest";
import { outline } from "./outline";

test("заголовки с уровнями, смещениями и id как у rehype-slug", () => {
  const text = "# Цель\n\nтекст\n\n## Итоги\n\n## Итоги\n\n### API `v1`\n";
  expect(outline(text)).toEqual([
    { depth: 1, text: "Цель", id: "цель", start: 0, end: 6 },
    { depth: 2, text: "Итоги", id: "итоги", start: 15, end: 23 },
    { depth: 2, text: "Итоги", id: "итоги-1", start: 25, end: 33 },
    { depth: 3, text: "API v1", id: "api-v1", start: 35, end: 47 },
  ]);
});

test("строки с # в блоке кода — не заголовки", () => {
  const text = "# Один\n\n```bash\n# комментарий\n```\n\nДва\n===\n";
  expect(outline(text).map((h) => h.text)).toEqual(["Один", "Два"]);
});
