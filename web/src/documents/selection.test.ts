import { expect, test } from "vitest";
import { findQuote, sourceRange } from "./selection";

test("findQuote: пробелы и переводы строк нормализуются", () => {
  const text = "Начало.\n\nЗамена   хвоста\nв одной транзакции.";
  expect(findQuote(text, "Замена хвоста в одной")).toBe(9);
  expect(findQuote(text, "нет такого")).toBe(-1);
});

test("sourceRange: по data-src-* блоков начала и конца выделения", () => {
  const root = document.createElement("div");
  root.innerHTML =
    '<p data-src-start="0" data-src-end="7">Первый <b>жирный</b></p>' +
    '<p data-src-start="9" data-src-end="15">Второй</p>';
  document.body.append(root);
  const bold = root.querySelector("b")?.firstChild;
  const second = root.querySelectorAll("p")[1]?.firstChild;
  if (bold == null || second == null) throw new Error("нет узлов");
  const selection = window.getSelection();
  if (selection === null) throw new Error("нет Selection");
  const range = document.createRange();
  range.setStart(bold, 1);
  range.setEnd(second, 3);
  selection.removeAllRanges();
  selection.addRange(range);
  expect(sourceRange(root, selection, "Первый **жирный**\n\nВторой")).toEqual({
    start: 0,
    end: 15,
  });
  root.remove();
});

test("sourceRange: без data-атрибутов — поиск цитаты, иначе начало", () => {
  const root = document.createElement("div");
  root.textContent = "Второй абзац";
  document.body.append(root);
  const selection = window.getSelection();
  if (selection === null || root.firstChild === null) throw new Error("нет Selection");
  const range = document.createRange();
  range.setStart(root.firstChild, 0);
  range.setEnd(root.firstChild, 6);
  selection.removeAllRanges();
  selection.addRange(range);
  expect(sourceRange(root, selection, "Первый\n\nВторой абзац")).toEqual({ start: 8, end: 14 });
  expect(sourceRange(root, selection, "совсем другое")).toEqual({ start: 0, end: 0 });
  root.remove();
});
