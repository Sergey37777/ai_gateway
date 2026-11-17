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
