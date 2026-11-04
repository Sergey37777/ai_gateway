import { memo } from "react";
import type { Segment, Word } from "../api/types";
import { formatClock } from "./exports";

interface Props {
  segment: Segment;
  words: readonly Word[];
  active: boolean;
  /** Индекс подсвеченного слова внутри сегмента. */
  activeWord: number | null;
  /** Плеер работает — таймкод и слова перематывают. */
  seekable: boolean;
  onSeek: (time: number) => void;
}

/** Таймкод сегмента; скобки — только для доступного имени ("[00:00:01]"). */
function Timecode({ seconds }: { seconds: number }) {
  return (
    <span className="timestamp">
      <span className="visually-hidden">[</span>
      {formatClock(seconds)}
      <span className="visually-hidden">]</span>
    </span>
  );
}

/**
 * Строка сегмента: кнопка таймкода (путь для клавиатуры) и текст — словами, если они есть.
 * Клик по слову обрабатывает список (делегирование по `data-start`), а не каждое слово:
 * в часе речи их ~10 тыс. Строки мемоизированы — при воспроизведении перерисовываются
 * только бывшая и новая активные.
 */
export const SegmentRow = memo(function SegmentRow({
  segment,
  words,
  active,
  activeWord,
  seekable,
  onSeek,
}: Props) {
  const text =
    words.length === 0 ? (
      segment.text.trim()
    ) : (
      <>
        {words.map((word, index) => (
          <span
            key={`${String(word.start)}-${String(index)}`}
            className={index === activeWord ? "word word-active" : "word"}
            data-start={seekable ? String(word.start) : undefined}
          >
            {index === 0 ? word.word.trimStart() : word.word}
          </span>
        ))}
      </>
    );
  return (
    <li className={active ? "segment segment-active" : "segment"}>
      {seekable ? (
        <button
          type="button"
          className="segment-time"
          onClick={() => {
            onSeek(segment.start);
          }}
        >
          <Timecode seconds={segment.start} />
        </button>
      ) : (
        <span className="segment-time">
          <Timecode seconds={segment.start} />
        </span>
      )}
      <span className="segment-text">{text}</span>
    </li>
  );
});
