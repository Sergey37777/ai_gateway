import { expect, test } from "vitest";
import { extractedTooLarge, limitBytes, planUpload } from "./plan";

const MB = 1024 * 1024;

test("limitBytes как на сервере", () => {
  expect(limitBytes(200)).toBe(200 * MB);
});

test("ровно лимит — direct", () => {
  expect(planUpload({ name: "a.wav", type: "audio/wav", size: MB }, 1)).toEqual({
    kind: "direct",
  });
});

test("видео больше лимита — extract", () => {
  expect(planUpload({ name: "a.mp4", type: "video/mp4", size: MB + 1 }, 1)).toEqual({
    kind: "extract",
  });
});

test("mkv без type → extract", () => {
  expect(planUpload({ name: "movie.MKV", type: "", size: 5 * MB }, 1)).toEqual({
    kind: "extract",
  });
});

test("аудио больше лимита — too_large", () => {
  expect(planUpload({ name: "a.wav", type: "audio/wav", size: 3 * MB }, 1)).toEqual({
    kind: "too_large",
    message: "Файл 3.0 МБ больше лимита 1 МБ (AIGW_MAX_UPLOAD_MB)",
  });
});

test("извлечённая дорожка", () => {
  expect(extractedTooLarge(MB, 1)).toBeNull();
  expect(extractedTooLarge(2 * MB, 1)).toBe("Аудиодорожка 2.0 МБ всё равно больше лимита 1 МБ");
});
