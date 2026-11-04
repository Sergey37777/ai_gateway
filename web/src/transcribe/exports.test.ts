import { expect, test } from "vitest";
import type { Transcription } from "../api/types";
import { formatClock, formatTimestamp, toJson, toSrt, toTxt, toVtt } from "./exports";

// те же примеры, что tests/test_formatting.py
const RESULT: Transcription = {
  text: "Привет. Мир.",
  language: "russian",
  duration: 3661.5,
  segments: [
    { id: 0, start: 0, end: 1.5, text: " Привет." },
    { id: 1, start: 1.5, end: 3661.5, text: " Мир." },
  ],
  words: [],
  raw: '{"text":"Привет. Мир."}',
};

test("formatTimestamp", () => {
  expect(formatTimestamp(3661.5, ",")).toBe("01:01:01,500");
  expect(formatTimestamp(0.0004, ".")).toBe("00:00:00.000");
  expect(formatTimestamp(1.9996, ",")).toBe("00:00:02,000");
});

test("formatClock", () => {
  expect(formatClock(3661.5)).toBe("01:01:01");
  expect(formatClock(59.9)).toBe("00:00:59");
});

test("srt", () => {
  expect(toSrt(RESULT)).toBe(
    "1\n00:00:00,000 --> 00:00:01,500\nПривет.\n\n2\n00:00:01,500 --> 01:01:01,500\nМир.\n",
  );
});

test("vtt", () => {
  expect(toVtt(RESULT)).toBe(
    "WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nПривет.\n\n00:00:01.500 --> 01:01:01.500\nМир.\n",
  );
});

test("txt и json", () => {
  expect(toTxt(RESULT)).toBe("Привет. Мир.");
  expect(toJson(RESULT)).toBe('{"text":"Привет. Мир."}');
});

test("пустые сегменты", () => {
  const empty = { ...RESULT, text: "", segments: [] };
  expect(toSrt(empty)).toBe("");
  expect(toVtt(empty)).toBe("WEBVTT\n\n");
});
