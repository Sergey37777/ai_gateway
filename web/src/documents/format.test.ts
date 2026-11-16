import { expect, test } from "vitest";
import { formatChars, questionsLabel } from "./format";

test.each([
  [1, "1 знак"],
  [3, "3 знака"],
  [11, "11 знаков"],
  [999, "999 знаков"],
  [24_890, "25 тыс. знаков"],
  [1_250_000, "1,3 млн знаков"],
])("formatChars(%i) → %s", (n, label) => {
  expect(formatChars(n)).toBe(label);
});

test.each([
  [1, "1 вопрос"],
  [3, "3 вопроса"],
  [5, "5 вопросов"],
  [21, "21 вопрос"],
])("questionsLabel(%i) → %s", (n, label) => {
  expect(questionsLabel(n)).toBe(label);
});
