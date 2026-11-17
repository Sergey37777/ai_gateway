/** Итог конвертации PDF/DOCX в Markdown; `title` — название из самого файла, если нашлось. */
export type Converted =
  { ok: true; markdown: string; title: string | null } | { ok: false; message: string };
