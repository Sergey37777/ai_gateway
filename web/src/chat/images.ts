/** Картинки для vision-моделей: data URL, большие уменьшаются (иначе съедают контекст). */

import type { ImageAttachment } from "./state";

export const MAX_IMAGE_SIDE = 2048;

const READ_ERROR = "Не удалось прочитать изображение";

/** Размер с длинной стороной не больше `max`, пропорции сохраняются. */
export function fitSize(
  width: number,
  height: number,
  max: number = MAX_IMAGE_SIDE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const scale = max / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error(READ_ERROR));
    });
    reader.addEventListener("error", () => {
      reject(new Error(READ_ERROR));
    });
    reader.readAsDataURL(blob);
  });
}

export async function readImage(file: File): Promise<ImageAttachment> {
  if (!file.type.startsWith("image/")) throw new Error(READ_ERROR);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (error) {
    throw new Error(READ_ERROR, { cause: error });
  }
  try {
    const size = fitSize(bitmap.width, bitmap.height);
    if (size.width === bitmap.width && size.height === bitmap.height) {
      return { name: file.name, dataUrl: await readAsDataUrl(file) };
    }
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error(READ_ERROR);
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const type = file.type === "image/png" ? "image/png" : "image/jpeg";
    return { name: file.name, dataUrl: canvas.toDataURL(type, 0.9) };
  } finally {
    bitmap.close();
  }
}
