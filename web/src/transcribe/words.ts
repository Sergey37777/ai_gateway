/** Слова по сегментам и поиск активного элемента по времени плеера. */

import type { Segment, Word } from "../api/types";

/**
 * Слова каждого сегмента. Слово относится к последнему сегменту, начавшемуся не позже него:
 * метки слов у faster-whisper бывают на десятки мс за границами сегмента. Слово до первого
 * сегмента — в первый. Обе последовательности отсортированы по `start` — один проход.
 */
export function groupWords(segments: readonly Segment[], words: readonly Word[]): Word[][] {
  const groups: Word[][] = segments.map(() => []);
  if (groups.length === 0) return groups;
  let index = 0;
  for (const word of words) {
    while (index + 1 < segments.length && (segments[index + 1]?.start ?? Infinity) <= word.start) {
      index += 1;
    }
    groups[index]?.push(word);
  }
  return groups;
}

/** Индекс элемента с `start <= time < end` (бинарный поиск); в паузе между ними — `null`. */
export function activeIndex(
  items: readonly { start: number; end: number }[],
  time: number,
): number | null {
  let low = 0;
  let high = items.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const item = items[mid];
    if (item === undefined) return null;
    if (time < item.start) high = mid - 1;
    else if (time >= item.end) low = mid + 1;
    else return mid;
  }
  return null;
}
