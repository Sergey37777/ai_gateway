/**
 * Генераторы маленьких PDF и DOCX для тестов и фикстур e2e (в приложение не попадают).
 */

export interface PdfTextSpec {
  text: string;
  x: number;
  y: number;
  size: number;
  bold?: boolean;
}

function escapePdfString(text: string): string {
  return text.replace(/[\\()]/gu, (char) => `\\${char}`);
}

/** PDF 1.4 со стандартными шрифтами Times (только ASCII), страницы 612×792. */
export function makePdf(pages: PdfTextSpec[][], info: { title?: string } = {}): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  const regular = add("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>");
  const bold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>");
  const pagesId = add("");
  const kids: number[] = [];
  for (const items of pages) {
    const stream = items
      .map(
        (item) =>
          `BT /${item.bold === true ? "F2" : "F1"} ${String(item.size)} Tf ` +
          `${String(item.x)} ${String(item.y)} Td (${escapePdfString(item.text)}) Tj ET`,
      )
      .join("\n");
    const content = add(`<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${String(pagesId)} 0 R /MediaBox [0 0 612 792] ` +
          `/Contents ${String(content)} 0 R ` +
          `/Resources << /Font << /F1 ${String(regular)} 0 R /F2 ${String(bold)} 0 R >> >> >>`,
      ),
    );
  }
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${kids.map((kid) => `${String(kid)} 0 R`).join(" ")}] ` +
    `/Count ${String(kids.length)} >>`;
  const catalog = add(`<< /Type /Catalog /Pages ${String(pagesId)} 0 R >>`);
  const infoId =
    info.title === undefined ? null : add(`<< /Title (${escapePdfString(info.title)}) >>`);

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(out.length);
    out += `${String(index + 1)} 0 obj\n${body}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  out +=
    `trailer\n<< /Size ${String(objects.length + 1)} /Root ${String(catalog)} 0 R` +
    (infoId === null ? "" : ` /Info ${String(infoId)} 0 R`) +
    ` >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
