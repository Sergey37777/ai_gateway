import { describe, expect, it } from "vitest";
import { convertDocx, htmlToMarkdown } from "./docx";
import { makeDocx } from "./testFiles";

function para(text: string, options: { style?: string; run?: string; list?: boolean } = {}) {
  const props =
    (options.style === undefined ? "" : `<w:pStyle w:val="${options.style}"/>`) +
    (options.list === true ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : "");
  return (
    `<w:p>${props === "" ? "" : `<w:pPr>${props}</w:pPr>`}` +
    `<w:r>${options.run ?? ""}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
  );
}

function cell(text: string): string {
  return `<w:tc>${para(text)}</w:tc>`;
}

describe("convertDocx", () => {
  it("headings, emphasis, lists, links", async () => {
    const body =
      para("Заголовок", { style: "Heading1" }) +
      para("Раздел", { style: "Heading2" }) +
      para("жирный", { run: "<w:rPr><w:b/></w:rPr>" }) +
      para("курсив", { run: "<w:rPr><w:i/></w:rPr>" }) +
      '<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>ссылка</w:t></w:r></w:hyperlink></w:p>' +
      para("один", { list: true }) +
      para("два", { list: true });
    const result = await convertDocx(makeDocx(body, { numbering: true }));
    expect(result).toEqual({
      ok: true,
      markdown:
        "# Заголовок\n\n## Раздел\n\n**жирный**\n\n*курсив*\n\n" +
        "[ссылка](https://example.com)\n\n- один\n- два\n",
      title: null,
    });
  });

  it("table gets a header row", async () => {
    const body = `<w:tbl><w:tr>${cell("A")}${cell("B")}</w:tr><w:tr>${cell("1")}${cell("2")}</w:tr></w:tbl>`;
    const result = await convertDocx(makeDocx(body));
    expect(result.ok && result.markdown).toBe("| A | B |\n| - | - |\n| 1 | 2 |\n");
  });

  it("drops images", async () => {
    const result = await convertDocx(makeDocx(para("Текст"), { image: true }));
    expect(result.ok).toBe(true);
    const markdown = result.ok ? result.markdown : "";
    expect(markdown).toBe("Текст\n");
    expect(markdown).not.toContain("data:");
    expect(markdown).not.toContain("![");
  });

  it("empty document", async () => {
    expect(await convertDocx(makeDocx(""))).toEqual({
      ok: false,
      message: "В документе нет текста",
    });
  });

  it("random bytes", async () => {
    expect(await convertDocx(new Uint8Array([1, 2, 3, 4]))).toEqual({
      ok: false,
      message: "Не удалось прочитать DOCX",
    });
  });
});

describe("htmlToMarkdown", () => {
  it("footnotes become gfm footnotes", () => {
    const html =
      '<p>Текст<sup><a href="#footnote-1" id="footnote-ref-1">[1]</a></sup></p>' +
      '<ol><li id="footnote-1"><p>Сноска <a href="#footnote-ref-1">↑</a></p></li></ol>';
    const markdown = htmlToMarkdown(html);
    expect(markdown).toBe("Текст[^fn-1]\n\n[^fn-1]: Сноска\n");
    expect(markdown).not.toContain("↑");
  });
});
