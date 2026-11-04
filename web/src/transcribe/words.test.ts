import { expect, test } from "vitest";
import type { Segment, Word } from "../api/types";
import { activeIndex, groupWords } from "./words";

const SEGMENTS: Segment[] = [
  { id: 0, start: 0, end: 2, text: " a b" },
  { id: 1, start: 2, end: 4, text: " c" },
];

function word(start: number, end = start + 0.1): Word {
  return { word: ` w${String(start)}`, start, end };
}

test("слова попадают в сегмент, в котором начинаются", () => {
  const groups = groupWords(SEGMENTS, [word(0.1), word(1.9), word(2.0)]);
  expect(groups.map((g) => g.map((w) => w.start))).toEqual([[0.1, 1.9], [2.0]]);
});

test("слово чуть раньше начала следующего сегмента остаётся в предыдущем", () => {
  const groups = groupWords(SEGMENTS, [word(1.97), word(2.01)]);
  expect(groups.map((g) => g.map((w) => w.start))).toEqual([[1.97], [2.01]]);
});

test("слово до первого сегмента — в первый, после последнего — в последний", () => {
  const groups = groupWords(SEGMENTS, [word(-0.05), word(5.0)]);
  expect(groups.map((g) => g.map((w) => w.start))).toEqual([[-0.05], [5.0]]);
});

test("пустые входы", () => {
  expect(groupWords([], [word(1)])).toEqual([]);
  expect(groupWords(SEGMENTS, [])).toEqual([[], []]);
});

test("activeIndex: внутри, в паузе, до первого и на конце последнего", () => {
  const items = [
    { start: 0, end: 0.5 },
    { start: 0.7, end: 1 },
  ];
  expect(activeIndex(items, 0.2)).toBe(0);
  expect(activeIndex(items, 0.6)).toBeNull();
  expect(activeIndex(items, 0.7)).toBe(1);
  expect(activeIndex(items, -1)).toBeNull();
  expect(activeIndex(items, 1)).toBeNull();
  expect(activeIndex([], 1)).toBeNull();
});
