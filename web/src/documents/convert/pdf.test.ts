// @vitest-environment node
// pdf.js в Node — legacy-сборка без worker (в jsdom её окружение неполное)
import { describe, expect, it } from "vitest";
import { convertPdf, type PdfLib } from "./pdf";
import { makePdf, type PdfTextSpec } from "./testFiles";

const lib: PdfLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

function article(): PdfTextSpec[][] {
  return [
    [
      { text: "Deep Results", x: 72, y: 720, size: 18, bold: true },
      { text: "The first para-", x: 72, y: 690, size: 10 },
      { text: "graph continues here.", x: 72, y: 678, size: 10 },
      { text: "1", x: 300, y: 30, size: 9 },
    ],
    [
      { text: "Second page text.", x: 72, y: 700, size: 10 },
      { text: "2", x: 300, y: 30, size: 9 },
    ],
  ];
}

describe("convertPdf", () => {
  it("converts a two-page article", async () => {
    const result = await convertPdf(makePdf(article(), { title: "Deep Results in PDF" }), lib);
    expect(result).toEqual({
      ok: true,
      markdown: "# Deep Results\n\nThe first paragraph continues here. Second page text.\n",
      title: "Deep Results in PDF",
    });
  });

  it("junk metadata title falls back to heading", async () => {
    const result = await convertPdf(
      makePdf(article(), { title: "Microsoft Word - draft.docx" }),
      lib,
    );
    expect(result.ok && result.title).toBe("Deep Results");
  });

  it("bold by font name: NimbusRomNo9L-Medi", async () => {
    const bytes = makePdf(
      [
        [
          { text: "Plain paragraph of body text.", x: 72, y: 700, size: 10 },
          { text: "Medium Heading", x: 72, y: 660, size: 10, bold: true },
          { text: "More body text after it.", x: 72, y: 640, size: 10 },
        ],
      ],
      { boldFont: "NimbusRomNo9L-Medi" },
    );
    const result = await convertPdf(bytes, lib);
    expect(result.ok && result.markdown).toBe(
      "Plain paragraph of body text.\n\n# Medium Heading\n\nMore body text after it.\n",
    );
  });

  it("long title is cut to the server limit (200)", async () => {
    const result = await convertPdf(makePdf(article(), { title: "Long ".repeat(80) }), lib);
    const title = result.ok ? result.title : null;
    expect(title).toHaveLength(200);
    expect(title?.endsWith("…")).toBe(true);
  });

  it("a pdf that fails to open is destroyed (worker freed)", async () => {
    const tasks: { destroyed: boolean }[] = [];
    const spy: PdfLib = {
      getDocument: (source) => {
        const task = lib.getDocument(source);
        tasks.push(task);
        return task;
      },
    };
    await convertPdf(new TextEncoder().encode("not a pdf"), spy);
    expect(tasks.map((task) => task.destroyed)).toEqual([true]);
  });

  it("pdf without text", async () => {
    const result = await convertPdf(makePdf([[], []]), lib);
    expect(result).toEqual({ ok: false, message: "В PDF нет текстового слоя — похоже на скан" });
  });

  it("broken pdf", async () => {
    const result = await convertPdf(new TextEncoder().encode("not a pdf"), lib);
    expect(result).toEqual({ ok: false, message: "Не удалось прочитать PDF" });
  });
});
