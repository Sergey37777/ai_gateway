/** Подписи истории: дата записи и статус задачи. */

import type { TranscriptionJob } from "../api/types";

const TIME = new Intl.DateTimeFormat("ru", { hour: "2-digit", minute: "2-digit" });
const DATE_TIME = new Intl.DateTimeFormat("ru", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** Сегодня — «18:02», иначе — «4 нояб., 18:02» (локальное время браузера). */
export function formatDate(iso: string, now: Date): string {
  const date = new Date(iso);
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return (sameDay ? TIME : DATE_TIME).format(date);
}

export function statusLabel(job: TranscriptionJob): string {
  switch (job.status) {
    case "queued":
      return job.queue_position === null
        ? "В очереди"
        : `В очереди: ${String(job.queue_position)}-я`;
    case "running":
      return job.progress === null
        ? "Распознаётся"
        : `Распознаётся — ${String(Math.round(job.progress * 100))}%`;
    case "done":
      return "Готово";
    case "failed":
      return "Ошибка";
    case "cancelled":
      return "Отменено";
  }
}
