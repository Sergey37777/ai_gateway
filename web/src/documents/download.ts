/** Скачивание текста файлом из браузера (документ, «моя версия» при конфликте). */

import type { DocumentFormat } from "../api/types";

export function downloadText(text: string, filename: string, format: DocumentFormat): void {
  const type = format === "markdown" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8";
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}
