import { describe, expect, it } from "vitest";
import { layoutPdf, type PdfPage, type PdfTextItem } from "./pdfLayout";

function item(str: string, x: number, y: number, size = 10, bold = false): PdfTextItem {
  return { str, x, y, width: str.length * size * 0.5, size, bold };
}

function page(items: PdfTextItem[]): PdfPage {
  return { width: 612, height: 792, items };
}

/** Страницы с колонтитулом сверху и номером снизу. */
function withRunningLines(count: number): PdfPage[] {
  return Array.from({ length: count }, (_, index) =>
    page([
      item("Journal of X 2026", 72, 770, 8),
      item(`Текст страницы ${String(index + 1)}.`, 72, 600),
      item(String(index + 1), 300, 30, 8),
    ]),
  );
}

describe("layoutPdf", () => {
  it("joins lines into paragraphs and removes hyphenation", () => {
    const joined = layoutPdf([page([item("Пер-", 72, 700), item("вый абзац", 72, 688)])]);
    expect(joined.markdown).toBe("Первый абзац\n");

    const split = layoutPdf([
      page([item("Первый абзац", 72, 700), item("еще строка", 72, 688), item("Второй", 72, 658)]),
    ]);
    expect(split.markdown).toBe("Первый абзац еще строка\n\nВторой\n");
  });

  it("two columns read left then right", () => {
    const items = [item("Заголовок статьи во всю ширину страницы", 150, 740, 18)];
    // строки колонок длиннее заголовка: основной кегль — по числу знаков
    for (const [index, y] of [700, 688, 676].entries()) {
      const n = String(index + 1);
      items.push(item(`левая колонка ${n}`, 72, y), item(`правая колонка ${n}`, 320, y));
    }
    const { markdown } = layoutPdf([page(items)]);
    expect(markdown).toBe(
      "# Заголовок статьи во всю ширину страницы\n\n" +
        "левая колонка 1 левая колонка 2 левая колонка 3 " +
        "правая колонка 1 правая колонка 2 правая колонка 3\n",
    );
  });

  it("narrow gutter: columns found by the empty strip, not by a gap threshold", () => {
    // промежуток между колонками 15 pt — меньше двух кеглей, как в статьях ACL
    const items: PdfTextItem[] = [];
    for (const [index, y] of [700, 688, 676, 664].entries()) {
      const n = String(index + 1);
      items.push(
        { str: `left column line ${n} text`, x: 72, y, width: 220, size: 10, bold: false },
        { str: `right column line ${n} text`, x: 307, y, width: 220, size: 10, bold: false },
      );
    }
    const { markdown } = layoutPdf([page(items)]);
    expect(markdown).toBe(
      "left column line 1 text left column line 2 text left column line 3 text " +
        "left column line 4 text right column line 1 text right column line 2 text " +
        "right column line 3 text right column line 4 text\n",
    );
  });

  it("indent is measured from the previous line, not the column edge", () => {
    const { markdown } = layoutPdf([
      page([
        item("Обычный абзац основного текста.", 72, 700),
        item("Аннотация с отступом слева, первая", 90, 688),
        item("строка и вторая строка аннотации.", 90, 676),
        item("Новый абзац с красной строки", 90, 664),
        item("и продолжение без отступа.", 72, 652),
      ]),
    ]);
    expect(markdown).toBe(
      "Обычный абзац основного текста.\n\n" +
        "Аннотация с отступом слева, первая строка и вторая строка аннотации. " +
        "Новый абзац с красной строки и продолжение без отступа.\n",
    );
  });

  it("keeps the hyphen of compound words split across lines", () => {
    const { markdown } = layoutPdf([
      page([item("a left-to-", 72, 700), item("right model", 72, 688)]),
    ]);
    expect(markdown).toBe("a left-to-right model\n");
  });

  it("article layout: bold section headings barely larger than body text", () => {
    // как в ACL: основной текст 11 pt, разделы — 12 pt жирным, подразделы — 11 pt жирным
    const { markdown } = layoutPdf([
      page([
        item("Article Title", 72, 740, 14.5),
        item("1 Introduction", 72, 700, 12, true),
        item("Body text of the introduction.", 72, 684, 11),
        item("2.1 Subsection", 72, 650, 11, true),
        item("Body text of the subsection.", 72, 634, 11),
      ]),
    ]);
    expect(markdown).toBe(
      "# Article Title\n\n## 1 Introduction\n\nBody text of the introduction.\n\n" +
        "### 2.1 Subsection\n\nBody text of the subsection.\n",
    );
  });

  it("author block above the columns comes before them", () => {
    const items: PdfTextItem[] = [
      item("A Two Column Paper Title", 150, 740, 14, true),
      { str: "First Author", x: 120, y: 700, width: 66, size: 12, bold: true },
      { str: "Second Author", x: 380, y: 700, width: 72, size: 12, bold: true },
      { str: "Abstract", x: 150, y: 655, width: 44, size: 12, bold: true },
    ];
    // основной текст 11 pt: авторы в 12 pt — не заголовок по кеглю
    for (const [index, y] of [640, 627, 614, 601].entries()) {
      const n = String(index + 1);
      items.push(
        { str: `left column line ${n} text`, x: 72, y, width: 220, size: 11, bold: false },
        { str: `right column line ${n} text`, x: 307, y, width: 220, size: 11, bold: false },
      );
    }
    const { markdown } = layoutPdf([page(items)]);
    expect(markdown).toBe(
      "# A Two Column Paper Title\n\nFirst Author Second Author\n\n## Abstract\n\n" +
        "left column line 1 text left column line 2 text left column line 3 text " +
        "left column line 4 text right column line 1 text right column line 2 text " +
        "right column line 3 text right column line 4 text\n",
    );
  });

  it("oversized figure text on later pages does not take over heading levels", () => {
    const { markdown } = layoutPdf([
      page([
        item("Notice in a slightly larger plain font", 72, 770, 12),
        item("Paper Title", 72, 740, 17),
        item("1 Introduction", 72, 700, 12, true),
        item("Body text of the introduction.", 72, 684),
      ]),
      page([
        item("2 Method", 72, 740, 12, true),
        item("Body text of the method.", 72, 724),
        item("Layer5", 72, 700, 20, true),
        item("Figure label", 72, 660, 16, true),
        item("Caption text of the figure.", 72, 630),
      ]),
    ]);
    // крупнее названия — текст рисунка; кегль, встретившийся один раз не на первой
    // странице, — тоже; не жирная строка чуть крупнее основного текста — не заголовок
    expect(markdown).toBe(
      "Notice in a slightly larger plain font\n\n# Paper Title\n\n## 1 Introduction\n\n" +
        "Body text of the introduction.\n\n## 2 Method\n\nBody text of the method.\n\n" +
        "Layer5\n\nFigure label\n\nCaption text of the figure.\n",
    );
  });

  it("detects headings by size and bold", () => {
    const { markdown, heading } = layoutPdf([
      page([
        item("Главный", 72, 740, 18),
        item("Раздел", 72, 700, 14),
        item("Текст раздела.", 72, 680),
        item("Подраздел", 72, 650, 10, true),
        item("Ещё текст.", 72, 630),
      ]),
    ]);
    expect(markdown).toBe(
      "# Главный\n\n## Раздел\n\nТекст раздела.\n\n### Подраздел\n\nЕщё текст.\n",
    );
    expect(heading).toBe("Главный");
  });

  it("removes running headers and page numbers", () => {
    const three = layoutPdf(withRunningLines(3)).markdown;
    expect(three).not.toContain("Journal");
    expect(three).toBe("Текст страницы 1. Текст страницы 2. Текст страницы 3.\n");

    const two = layoutPdf(withRunningLines(2)).markdown;
    expect(two).toContain("Journal of X 2026");
  });

  it("page numbers are dropped even in short documents", () => {
    const { markdown } = layoutPdf([
      page([item("Единственная страница.", 72, 600), item("1", 300, 30, 8)]),
    ]);
    expect(markdown).toBe("Единственная страница.\n");
  });

  it("bullets become list items", () => {
    const { markdown } = layoutPdf([
      page([item("Список:", 72, 700), item("• один", 72, 688), item("• два", 72, 676)]),
    ]);
    expect(markdown).toBe("Список:\n\n- один\n- два\n");
  });

  it("escapes markdown and math", () => {
    const { markdown } = layoutPdf([
      page([item("Цена $5 * 2_x [a] <b>", 72, 700), item("# не заголовок", 72, 660)]),
    ]);
    expect(markdown).toBe("Цена \\$5 \\* 2\\_x \\[a\\] \\<b>\n\n\\# не заголовок\n");
  });

  it("empty pages give empty markdown", () => {
    expect(layoutPdf([page([])])).toEqual({ markdown: "", heading: null });
  });
});
