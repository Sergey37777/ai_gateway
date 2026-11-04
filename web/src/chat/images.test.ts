import { expect, test } from "vitest";
import { fitSize, MAX_IMAGE_SIDE, readImage } from "./images";

test("fitSize", () => {
  expect(MAX_IMAGE_SIDE).toBe(2048);
  expect(fitSize(4000, 3000)).toEqual({ width: 2048, height: 1536 });
  expect(fitSize(3000, 4000)).toEqual({ width: 1536, height: 2048 });
  expect(fitSize(1000, 500)).toEqual({ width: 1000, height: 500 });
  expect(fitSize(2048, 2048)).toEqual({ width: 2048, height: 2048 });
});

test("не картинка — ошибка", async () => {
  await expect(readImage(new File(["x"], "a.txt", { type: "text/plain" }))).rejects.toThrow(
    "Не удалось прочитать изображение",
  );
});
