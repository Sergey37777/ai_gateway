/** Как отправить файл: как есть, через извлечение аудио или никак (больше лимита). */

import { isVideo } from "./media";

const MIB = 1024 * 1024;

export type UploadPlan =
  { kind: "direct" } | { kind: "extract" } | { kind: "too_large"; message: string };

/** Лимит в байтах — как на сервере (`AIGW_MAX_UPLOAD_MB` МиБ). */
export function limitBytes(limitMb: number): number {
  return limitMb * MIB;
}

function mb(size: number): string {
  return (size / MIB).toFixed(1);
}

export function planUpload(
  file: { name: string; type: string; size: number },
  limitMb: number,
): UploadPlan {
  if (file.size <= limitBytes(limitMb)) return { kind: "direct" };
  if (isVideo(file)) return { kind: "extract" };
  return {
    kind: "too_large",
    message: `Файл ${mb(file.size)} МБ больше лимита ${String(limitMb)} МБ (AIGW_MAX_UPLOAD_MB)`,
  };
}

/** Сообщение, если извлечённая дорожка всё равно не проходит по лимиту, иначе `null`. */
export function extractedTooLarge(size: number, limitMb: number): string | null {
  if (size <= limitBytes(limitMb)) return null;
  return `Аудиодорожка ${mb(size)} МБ всё равно больше лимита ${String(limitMb)} МБ`;
}
