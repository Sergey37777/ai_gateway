/** Загрузка формы через XMLHttpRequest — ради прогресса (у fetch его нет). */

import { authHeaders, notifyUnauthorized } from "./apiKey";
import { networkError, parseErrorResponse } from "./errors";

export interface UploadHooks {
  onUploadProgress?: (fraction: number) => void;
  /** Файл загружен целиком — дальше работает сервер. */
  onUploaded?: () => void;
  signal?: AbortSignal;
}

interface ProgressTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
}

/** Часть XMLHttpRequest, которой пользуется модуль (для подмены в тестах). */
export interface XhrLike extends ProgressTarget {
  readonly status: number;
  readonly responseText: string;
  readonly upload: ProgressTarget;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  getResponseHeader(name: string): string | null;
  send(body: FormData): void;
  abort(): void;
}

/** POST формы с ключом API; 2xx — `parse(тело)`, иначе `ApiError` (401 — запрос ключа). */
export function xhrUpload<T>(
  url: string,
  form: FormData,
  parse: (text: string) => T,
  hooks: UploadHooks = {},
  createXhr: () => XhrLike = () => new XMLHttpRequest(),
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = createXhr();
    const onAbortSignal = () => {
      xhr.abort();
    };
    const cleanup = () => {
      hooks.signal?.removeEventListener("abort", onAbortSignal);
    };

    xhr.upload.addEventListener("progress", (event) => {
      if (event instanceof ProgressEvent && event.lengthComputable && event.total > 0) {
        hooks.onUploadProgress?.(event.loaded / event.total);
      }
    });
    xhr.upload.addEventListener("load", () => {
      hooks.onUploaded?.();
    });
    xhr.addEventListener("load", () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(parse(xhr.responseText));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      if (xhr.status === 401) notifyUnauthorized();
      reject(
        parseErrorResponse(xhr.status, xhr.responseText, xhr.getResponseHeader("Retry-After")),
      );
    });
    xhr.addEventListener("error", () => {
      cleanup();
      reject(networkError());
    });
    xhr.addEventListener("abort", () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    });

    if (hooks.signal?.aborted === true) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    hooks.signal?.addEventListener("abort", onAbortSignal);
    xhr.open("POST", url);
    for (const [name, value] of Object.entries(authHeaders())) xhr.setRequestHeader(name, value);
    // без таймаута: загрузка больших файлов по LAN идёт минуты
    xhr.send(form);
  });
}
