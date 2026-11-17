/**
 * Генераторы маленьких PDF и DOCX для тестов и фикстур e2e (в приложение не попадают).
 */

import { strToU8, zipSync } from "fflate";

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

const RELS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const DOC_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  `xmlns:r="${RELS_NS}" ` +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

/** Картинка 1×1 PNG. */
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);

const IMAGE_PARAGRAPH =
  '<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture"/><a:graphic>' +
  '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
  '<pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill></pic:pic></a:graphicData>' +
  "</a:graphic></wp:inline></w:drawing></w:r></w:p>";

const NUMBERING =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/>' +
  '<w:lvlText w:val="•"/></w:lvl></w:abstractNum>' +
  '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>';

function rel(id: string, type: string, target: string, external = false): string {
  return (
    `<Relationship Id="${id}" Type="${RELS_NS}/${type}" Target="${target}"` +
    `${external ? ' TargetMode="External"' : ""}/>`
  );
}

/**
 * Минимальный DOCX: `bodyXml` — содержимое `<w:body>`. Гиперссылка `rIdLink` ведёт на
 * https://example.com; `image` добавляет абзац с картинкой, `numbering` — маркированный список
 * `numId=1`.
 */
export function makeDocx(
  bodyXml: string,
  options: { image?: boolean; numbering?: boolean } = {},
): Uint8Array {
  const rels = [rel("rIdLink", "hyperlink", "https://example.com", true)];
  if (options.image === true) rels.push(rel("rIdImg", "image", "media/1.png"));
  if (options.numbering === true) rels.push(rel("rIdNum", "numbering", "numbering.xml"));
  const body = bodyXml + (options.image === true ? IMAGE_PARAGRAPH : "");
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="png" ContentType="image/png"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        "</Types>",
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        rel("rId1", "officeDocument", "word/document.xml") +
        "</Relationships>",
    ),
    "word/_rels/document.xml.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        rels.join("") +
        "</Relationships>",
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:document ${DOC_NS}><w:body>${body}</w:body></w:document>`,
    ),
  };
  if (options.image === true) files["word/media/1.png"] = PNG;
  if (options.numbering === true) files["word/numbering.xml"] = strToU8(NUMBERING);
  return zipSync(files);
}
