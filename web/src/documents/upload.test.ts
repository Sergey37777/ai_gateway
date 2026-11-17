import { beforeEach, expect, test, vi } from "vitest";
import { convertDocx } from "./convert/docx";
import { convertPdf } from "./convert/pdf";
import { prepareFile } from "./upload";

vi.mock("./convert/pdf", () => ({ convertPdf: vi.fn<typeof convertPdf>() }));
vi.mock("./convert/docx", () => ({ convertDocx: vi.fn<typeof convertDocx>() }));
const pdf = vi.mocked(convertPdf);
const docx = vi.mocked(convertDocx);

beforeEach(() => {
  pdf.mockReset();
  docx.mockReset();
});

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
  const result = await prepareFile(file(["x"], "a.odt"), 5);
  expect(result).toEqual({
    ok: false,
    name: "a.odt",
    message: "Поддерживаются .md, .markdown, .txt, .pdf и .docx",
  });
});

test("старый .doc → просьба сохранить как .docx", async () => {
  const result = await prepareFile(file(["x"], "old.doc"), 5);
  expect(result).toEqual({
    ok: false,
    name: "old.doc",
    message: "Старый формат .doc не поддерживается — сохраните как .docx",
  });
});

test("PDF (расширение в верхнем регистре) → Markdown, название из PDF, имя .md", async () => {
  pdf.mockResolvedValue({ ok: true, markdown: "# Статья\n", title: "Настоящее название" });
  const result = await prepareFile(file(["%PDF-1.4"], "PAPER.PDF"), 5);
  expect(result).toEqual({
    ok: true,
    title: "Настоящее название",
    filename: "PAPER.md",
    format: "markdown",
    text: "# Статья\n",
  });
  expect(new TextDecoder().decode(pdf.mock.calls[0]?.[0])).toBe("%PDF-1.4");
});

test("PDF без названия внутри → название из имени файла", async () => {
  pdf.mockResolvedValue({ ok: true, markdown: "текст\n", title: null });
  const result = await prepareFile(file(["%PDF"], "2411.01234v2.pdf"), 5);
  expect(result.ok && result.title).toBe("2411.01234v2");
});

test("DOCX → Markdown", async () => {
  docx.mockResolvedValue({ ok: true, markdown: "# Заметки\n", title: null });
  const result = await prepareFile(file(["PK"], "Notes.DOCX"), 5);
  expect(result).toEqual({
    ok: true,
    title: "Notes",
    filename: "Notes.md",
    format: "markdown",
    text: "# Заметки\n",
  });
});

test("ошибка конвертера доходит до пользователя", async () => {
  pdf.mockResolvedValue({ ok: false, message: "PDF защищён паролем" });
  expect(await prepareFile(file(["%PDF"], "x.pdf"), 5)).toEqual({
    ok: false,
    name: "x.pdf",
    message: "PDF защищён паролем",
  });
});

test("исключение конвертера → «Не удалось прочитать …»", async () => {
  pdf.mockRejectedValue(new Error("boom"));
  docx.mockRejectedValue(new Error("boom"));
  expect(await prepareFile(file(["%PDF"], "x.pdf"), 5)).toMatchObject({
    message: "Не удалось прочитать PDF",
  });
  expect(await prepareFile(file(["PK"], "x.docx"), 5)).toMatchObject({
    message: "Не удалось прочитать DOCX",
  });
});

test("текст после конвертации больше лимита документа", async () => {
  pdf.mockResolvedValue({ ok: true, markdown: "a".repeat(2 * MB), title: null });
  expect(await prepareFile(file(["%PDF"], "x.pdf"), 1)).toEqual({
    ok: false,
    name: "x.pdf",
    message: "Текст документа больше 1 МБ",
  });
});

test("PDF больше 200 МБ → ошибка до чтения; меньше — лимит документа не мешает", async () => {
  const big = file(["%PDF"], "big.pdf");
  Object.defineProperty(big, "size", { value: 200 * MB + 1 });
  expect(await prepareFile(big, 5)).toEqual({
    ok: false,
    name: "big.pdf",
    message: "Файл больше 200 МБ",
  });
  expect(pdf).not.toHaveBeenCalled();

  pdf.mockResolvedValue({ ok: true, markdown: "текст\n", title: null });
  const scan = file([new Uint8Array(2 * MB)], "scan-heavy.pdf");
  expect((await prepareFile(scan, 1)).ok).toBe(true);
});

test("имя из одного расширения → «Без названия»", async () => {
  const result = await prepareFile(file(["x"], ".md"), 5);
  expect(result.ok && result.title).toBe("Без названия");
});
