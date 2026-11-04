/**
 * Извлечение аудиодорожки из видео в браузере (ffmpeg.wasm, однопоточное ядро).
 *
 * Файл монтируется через WORKERFS и читается срезами — в память wasm не копируется;
 * проверено на mp4 и mkv по 4,95 ГБ. `-c copy` без перекодирования, результат — Matroska
 * (принимает любой аудиокодек, PyAV на сервере её читает).
 */

import { baseName } from "./media";

export interface ExtractHooks {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

const NO_AUDIO_MARKER = "matches no streams";

/** Текст ошибки по логу ffmpeg. */
export function extractionErrorMessage(log: string[]): string {
  if (log.some((line) => line.includes(NO_AUDIO_MARKER))) return "В видео нет аудиодорожки";
  const tail = log
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-3);
  return `Не удалось извлечь аудио: ${tail.join("; ")}`;
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

export async function extractAudio(file: File, hooks: ExtractHooks = {}): Promise<File> {
  const { signal, onProgress } = hooks;
  if (signal?.aborted === true) throw abortError();

  // ~32 МБ ядра грузятся только когда извлечение действительно нужно
  const [{ FFmpeg, FFFSType }, { default: coreURL }, { default: wasmURL }] = await Promise.all([
    import("@ffmpeg/ffmpeg"),
    import("@ffmpeg/core?url"),
    import("@ffmpeg/core/wasm?url"),
  ]);
  const ffmpeg = new FFmpeg();
  const log: string[] = [];
  ffmpeg.on("log", ({ message }) => {
    log.push(message);
  });
  ffmpeg.on("progress", ({ progress }) => {
    if (Number.isFinite(progress)) onProgress?.(Math.min(Math.max(progress, 0), 1));
  });
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    ffmpeg.terminate();
  };
  signal?.addEventListener("abort", onAbort);

  try {
    try {
      await ffmpeg.load({ coreURL, wasmURL });
    } catch (error) {
      if (aborted) throw abortError();
      throw new Error(`Не удалось загрузить ffmpeg.wasm: ${String(error)}`, { cause: error });
    }
    await ffmpeg.createDir("/input");
    await ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, "/input");
    const code = await ffmpeg.exec([
      "-i",
      `/input/${file.name}`,
      "-map",
      "0:a:0",
      "-c",
      "copy",
      "-y",
      "/out.mka",
    ]);
    if (code !== 0) throw new Error(extractionErrorMessage(log));
    const data = await ffmpeg.readFile("/out.mka");
    if (typeof data === "string") throw new Error(extractionErrorMessage(log));
    // копия в обычный ArrayBuffer: Blob не принимает представление поверх SharedArrayBuffer
    return new File([new Uint8Array(data)], `${baseName(file.name)}.mka`, {
      type: "audio/x-matroska",
    });
  } catch (error) {
    if (aborted) throw abortError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // воркер держит память wasm — освобождаем и после успеха
    if (!aborted) ffmpeg.terminate();
  }
}
