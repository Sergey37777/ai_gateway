import { expect, test } from "vitest";
import { prepareFile } from "./upload";

const MB = 1024 * 1024;

function file(parts: BlobPart[], name: string): File {
  return new File(parts, name);
}

test("markdown: BOM снимается, переводы строк → \\n, название из имени", async () => {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const result = await prepareFile(file([bom, "# Заголовок\r\nстрока\rещё"], "Мои заметки.md"), 5);
  expect(result).toEqual({
    ok: true,
    title: "Мои заметки",
    filename: "Мои заметки.md",
    format: "markdown",
    text: "# Заголовок\nстрока\nещё",
  });
});

test.each([
  ["notes.MD", "markdown"],
  ["notes.markdown", "markdown"],
  ["log.txt", "text"],
])("формат по расширению: %s → %s", async (name, format) => {
  const result = await prepareFile(file(["x"], name), 5);
  expect(result.ok && result.format).toBe(format);
});

test("не UTF-8 → ошибка", async () => {
  // «Привет» в cp1251
  const cp1251 = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
  expect(await prepareFile(file([cp1251], "a.md"), 5)).toEqual({
    ok: false,
    name: "a.md",
    message: "Файл не в UTF-8",
  });
});

test("NUL → похоже на двоичный файл", async () => {
  const result = await prepareFile(file(["a\u0000b"], "a.md"), 5);
  expect(result).toEqual({ ok: false, name: "a.md", message: "Похоже на двоичный файл" });
});

test("больше лимита → ошибка до чтения", async () => {
  const result = await prepareFile(file([new Uint8Array(MB + 1)], "big.md"), 1);
  expect(result).toEqual({ ok: false, name: "big.md", message: "Файл больше 1 МБ" });
});

test("чужое расширение → ошибка", async () => {
  const result = await prepareFile(file(["x"], "a.pdf"), 5);
  expect(result).toEqual({
    ok: false,
    name: "a.pdf",
    message: "Поддерживаются только .md, .markdown и .txt",
  });
});

test("имя из одного расширения → «Без названия»", async () => {
  const result = await prepareFile(file(["x"], ".md"), 5);
  expect(result.ok && result.title).toBe("Без названия");
});
