import { expect, test } from "vitest";
import { extractionErrorMessage } from "./extractAudio";

test("нет аудиодорожки", () => {
  expect(
    extractionErrorMessage([
      "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/input/a.mp4':",
      "Stream map '0:a:0' matches no streams.",
      "To ignore this, add a trailing '?' to the map.",
    ]),
  ).toBe("В видео нет аудиодорожки");
});

test("прочая ошибка — последние три непустые строки", () => {
  expect(extractionErrorMessage(["a", "", "b", "c", "  ", "d", "Aborted()"])).toBe(
    "Не удалось извлечь аудио: c; d; Aborted()",
  );
});
