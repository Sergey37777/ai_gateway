/** Тип медиафайла, имена и формат записи с микрофона. */

export const VIDEO_EXTENSIONS = ["mp4", "mkv", "webm", "mov", "m4v", "avi"] as const;

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Видео по MIME-типу или, если тип пустой (часто для .mkv), по расширению. */
export function isVideo(file: { name: string; type: string }): boolean {
  if (file.type.startsWith("video/")) return true;
  if (file.type !== "") return false;
  return (VIDEO_EXTENSIONS as readonly string[]).includes(extension(file.name));
}

/** Имя без последнего расширения; для скачивания результатов. */
export function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  const base = dot < 0 ? name : name.slice(0, dot);
  return base === "" ? "transcript" : base;
}

const RECORDER_TYPES = [
  { mimeType: "audio/webm;codecs=opus", ext: "webm" },
  { mimeType: "audio/ogg;codecs=opus", ext: "ogg" },
  { mimeType: "audio/mp4", ext: "m4a" },
] as const;

/** Первый формат, который умеет `MediaRecorder` этого браузера. */
export function pickRecorderType(
  isSupported: (mimeType: string) => boolean,
): { mimeType: string; ext: string } | null {
  const found = RECORDER_TYPES.find((t) => isSupported(t.mimeType));
  return found === undefined ? null : { mimeType: found.mimeType, ext: found.ext };
}
