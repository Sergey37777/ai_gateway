import { expect, test } from "vitest";
import { parseTranscription } from "./transcribe";

const VERBOSE = JSON.stringify({
  task: "transcribe",
  language: "english",
  duration: 2.0,
  text: "Hello world.",
  segments: [{ id: 0, start: 0, end: 2, text: " Hello world.", avg_logprob: -0.1 }],
});

test("разбор verbose_json", () => {
  const result = parseTranscription(VERBOSE);
  expect(result.text).toBe("Hello world.");
  expect(result.language).toBe("english");
  expect(result.segments).toEqual([{ id: 0, start: 0, end: 2, text: " Hello world." }]);
  expect(result.raw).toBe(VERBOSE);
});

test("слова разбираются, мусор отбрасывается", () => {
  const body = JSON.stringify({
    text: "Привет",
    segments: [],
    words: [{ word: " Привет", start: 0, end: 0.5 }, { word: 1 }, null],
  });
  expect(parseTranscription(body).words).toEqual([{ word: " Привет", start: 0, end: 0.5 }]);
});

test("нет поля words — пустой массив", () => {
  expect(parseTranscription(VERBOSE).words).toEqual([]);
});

test("ответ без text — ошибка", () => {
  expect(() => parseTranscription('{"segments": []}')).toThrow("Некорректный ответ");
});
