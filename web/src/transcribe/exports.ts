/** Экспорт результата в txt / srt / vtt / json; таймкоды — как в серверном formatting.py. */

import type { Transcription } from "../api/types";

export const EXPORT_FORMATS = ["txt", "srt", "vtt", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** `ЧЧ:ММ:СС{marker}ммм` с округлением до ближайшей миллисекунды. */
export function formatTimestamp(seconds: number, marker: "," | "."): string {
  const totalMs = Math.round(seconds * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${marker}${pad(ms, 3)}`;
}

/** `ЧЧ:ММ:СС` (секунды отбрасываются вниз) — для списка сегментов. */
export function formatClock(seconds: number): string {
  const total = Math.floor(seconds);
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

export function toTxt(t: Transcription): string {
  return t.text;
}

export function toSrt(t: Transcription): string {
  return t.segments
    .map(
      (s, i) =>
        `${String(i + 1)}\n${formatTimestamp(s.start, ",")} --> ${formatTimestamp(s.end, ",")}\n${s.text.trim()}\n`,
    )
    .join("\n");
}

export function toVtt(t: Transcription): string {
  const blocks = t.segments.map(
    (s) =>
      `${formatTimestamp(s.start, ".")} --> ${formatTimestamp(s.end, ".")}\n${s.text.trim()}\n`,
  );
  return "WEBVTT\n\n" + blocks.join("\n");
}

export function toJson(t: Transcription): string {
  return t.raw;
}

export const EXPORTERS: Record<ExportFormat, (t: Transcription) => string> = {
  txt: toTxt,
  srt: toSrt,
  vtt: toVtt,
  json: toJson,
};
