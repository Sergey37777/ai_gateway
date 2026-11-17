import { gzipSync, strToU8, zipSync } from "fflate";
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "../api/errors";
import { convertPdf } from "./convert/pdf";
import { doc } from "./fixtures";
import { importFiles, type ImportOptions } from "./importFiles";

// браузерная сборка pdf.js с worker в Vitest не поднимается; DOCX — настоящий mammoth
vi.mock("./convert/pdf", () => ({ convertPdf: vi.fn<typeof convertPdf>() }));
const pdf = vi.mocked(convertPdf);

beforeEach(() => {
  pdf.mockReset();
});

function setup() {
  let created = 0;
  const create = vi.fn<ImportOptions["create"]>((body) => {
    created += 1;
    return Promise.resolve(doc(`doc-${String(created)}`, body));
  });
  const onProgress = vi.fn<ImportOptions["onProgress"]>();
  return { create, onProgress, options: { maxMb: 1, create, onProgress } };
}

const zipFile = (files: Record<string, Uint8Array>, name = "docs.zip") =>
  new File([zipSync(files)], name);

test("обычные файлы и архив: документы по одному, названия из путей, итог по архиву", async () => {
  const { create, onProgress, options } = setup();
  const archive = zipFile({
    "docs/readme.md": strToU8("# Readme"),
    "docs/guide/install.txt": strToU8("шаги"),
    "docs/logo.png": new Uint8Array([1]),
    "docs/icon.svg": strToU8("<svg/>"),
  });
  const result = await importFiles([new File(["# A"], "a.md"), archive], options);
  expect(create.mock.calls.map(([body]) => [body.title, body.filename, body.format])).toEqual([
    ["a", "a.md", "markdown"],
    ["readme", "readme.md", "markdown"],
    ["guide/install", "install.txt", "text"],
  ]);
  expect(result.last?.id).toBe("doc-3");
  expect(result.errors).toEqual([]);
  expect(result.notes).toEqual(["Из архива docs.zip: 2 документа, пропущено 2 файла других типов"]);
  expect(onProgress.mock.calls).toEqual([
    [0, 3],
    [1, 3],
    [2, 3],
    [3, 3],
  ]);
});

test("ошибки: битый архив, файл не в UTF-8 и большой файл внутри, отказ сервера", async () => {
  const { create, options } = setup();
  create.mockImplementationOnce(() => Promise.reject(new ApiError("Сервер недоступен", 503)));
  const archive = new File([gzipSync(strToU8("не tar"))], "bad.tar.gz");
  const mixed = zipFile({
    "first.md": strToU8("ok"),
    "cp1251.md": new Uint8Array([0xcf, 0xf0]),
    "big.md": new Uint8Array(2 * 1024 * 1024).fill(0x61),
  });
  const result = await importFiles([archive, mixed], options);
  // размер текста внутри архива проверяет подготовка файла — ошибки в порядке файлов
  expect(result.errors).toEqual([
    { name: "bad.tar.gz", message: "Внутри .gz нет tar-архива" },
    { name: "docs.zip › first.md", message: "Сервер недоступен" },
    { name: "docs.zip › cp1251.md", message: "Файл не в UTF-8" },
    { name: "docs.zip › big.md", message: "Файл больше 1 МБ" },
  ]);
  expect(result.last).toBeNull();
  expect(result.notes).toEqual(["Из архива docs.zip: 0 документов"]);
});

test("архив без текстовых файлов", async () => {
  const { options } = setup();
  const result = await importFiles(
    [zipFile({ "a.png": new Uint8Array([1]) }, "pics.zip")],
    options,
  );
  expect(result.errors).toEqual([
    { name: "pics.zip", message: "В архиве нет файлов .md, .markdown, .txt, .pdf или .docx" },
  ]);
  expect(result.notes).toEqual([]);
});

test("битый DOCX в пачке: понятная ошибка, остальные файлы создаются", async () => {
  const { create, options } = setup();
  const result = await importFiles(
    [new File([new Uint8Array([1, 2, 3])], "broken.docx"), new File(["# ok"], "ok.md")],
    options,
  );
  expect(result.errors).toEqual([{ name: "broken.docx", message: "Не удалось прочитать DOCX" }]);
  expect(create).toHaveBeenCalledTimes(1);
  expect(result.last?.id).toBe("doc-1");
});

test("PDF в архиве: Markdown, название по пути, а не из PDF", async () => {
  const { create, options } = setup();
  pdf.mockResolvedValue({ ok: true, markdown: "# Из PDF\n", title: "Название внутри PDF" });
  const archive = zipFile({
    "a/paper.pdf": strToU8("%PDF-1.4"),
    "a/notes.md": strToU8("заметки"),
  });
  const result = await importFiles([archive], options);
  expect(result.errors).toEqual([]);
  expect(
    create.mock.calls.map(([body]) => [body.title, body.filename, body.format, body.text]),
  ).toEqual([
    ["paper", "paper.md", "markdown", "# Из PDF\n"],
    ["notes", "notes.md", "markdown", "заметки"],
  ]);
});
