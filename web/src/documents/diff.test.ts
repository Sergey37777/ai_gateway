import { expect, test } from "vitest";
import { diffWords } from "./diff";

test("замена слова в середине", () => {
  expect(diffWords("Кот сидит на окне", "Кот лежит на окне")).toEqual([
    { kind: "same", text: "Кот " },
    { kind: "del", text: "сидит" },
    { kind: "add", text: "лежит" },
    { kind: "same", text: " на окне" },
  ]);
});

test("вставка и удаление", () => {
  expect(diffWords("один три", "один два три")).toEqual([
    { kind: "same", text: "один " },
    { kind: "add", text: "два " },
    { kind: "same", text: "три" },
  ]);
  expect(diffWords("a b c", "a c")).toEqual([
    { kind: "same", text: "a " },
    { kind: "del", text: "b " },
    { kind: "same", text: "c" },
  ]);
});

test("пустые стороны", () => {
  expect(diffWords("", "новое")).toEqual([{ kind: "add", text: "новое" }]);
  expect(diffWords("старое", "")).toEqual([{ kind: "del", text: "старое" }]);
  expect(diffWords("same", "same")).toEqual([{ kind: "same", text: "same" }]);
});

test("склейка частей восстанавливает обе стороны", () => {
  const before = "Первая строка\nвторая строка с ошибкой\n\nтретья";
  const after = "Первая строка\nвторая исправленная строка\n\nтретья и ещё";
  const parts = diffWords(before, after);
  expect(
    parts
      .filter((p) => p.kind !== "add")
      .map((p) => p.text)
      .join(""),
  ).toBe(before);
  expect(
    parts
      .filter((p) => p.kind !== "del")
      .map((p) => p.text)
      .join(""),
  ).toBe(after);
});

test("слишком большие блоки — было/стало целиком", () => {
  const before = Array.from({ length: 3000 }, (_, i) => `a${String(i)}`).join(" ");
  const after = Array.from({ length: 3000 }, (_, i) => `b${String(i)}`).join(" ");
  expect(diffWords(before, after)).toEqual([
    { kind: "del", text: before },
    { kind: "add", text: after },
  ]);
});
