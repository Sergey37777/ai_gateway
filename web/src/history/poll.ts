/** Опрос сервера, пока задача в работе. */

import { useEffect, useRef } from "react";
import type { JobStatus } from "../api/types";

export function isActive(status: JobStatus): boolean {
  return status === "queued" || status === "running";
}

/**
 * Вызывает `fn` раз в `intervalMs`, пока `enabled`. Следующий вызов планируется только после
 * завершения предыдущего — медленный ответ не накладывается на новый запрос.
 */
export function usePolling(fn: () => Promise<void>, intervalMs: number, enabled: boolean): void {
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    if (!enabled) return undefined;
    const stop = new AbortController();
    const timer = { id: 0 };
    const tick = () => {
      fnRef
        .current()
        .catch(() => {
          // ошибку показывает сам fn; опрос продолжается
        })
        .finally(() => {
          if (!stop.signal.aborted) timer.id = window.setTimeout(tick, intervalMs);
        });
    };
    timer.id = window.setTimeout(tick, intervalMs);
    return () => {
      stop.abort();
      window.clearTimeout(timer.id);
    };
  }, [intervalMs, enabled]);
}
