/** Копирует текст; без secure context `navigator.clipboard` нет — fallback через textarea. */
export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && typeof navigator.clipboard?.writeText === "function") {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    document.execCommand("copy");
  } finally {
    area.remove();
  }
}
