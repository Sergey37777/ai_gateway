import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const HELLO_WAV = fileURLToPath(new URL("../../tests/fixtures/hello.wav", import.meta.url));
// 1,35 МиБ при лимите 1 МиБ — UI должен извлечь аудио в браузере
const HELLO_MP4 = fileURLToPath(new URL("fixtures/hello.mp4", import.meta.url));

test("аудио ≤ лимита: текст и скачивание srt", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Аудио или видео файл").setInputFiles(HELLO_WAV);
  await expect(page.locator(".transcript-text")).toContainText(/hello/i, { timeout: 120_000 });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "srt" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("hello.srt");
  const content = await readFile(await download.path(), "utf8");
  expect(content.startsWith("1\n00:00:00,")).toBe(true);
});

test("видео больше лимита: извлечение аудио в браузере", async ({ page }) => {
  // тело XHR с Blob Playwright не показывает — запоминаем файлы, которые UI кладёт в форму
  await page.addInitScript(() => {
    const files: { name: string; size: number }[] = [];
    Reflect.set(window, "__uploaded", files);
    // oxlint-disable-next-line typescript/unbound-method -- вызывается ниже с this формы
    const append = FormData.prototype.append;
    FormData.prototype.append = function (
      this: FormData,
      ...args: [name: string, value: string | Blob, filename?: string]
    ) {
      const [, value, filename] = args;
      if (value instanceof File) files.push({ name: filename ?? value.name, size: value.size });
      Reflect.apply(append, this, args);
    };
  });
  await page.goto("/");
  await page.getByLabel("Аудио или видео файл").setInputFiles(HELLO_MP4);
  await expect(page.locator(".transcript-text")).toContainText(/hello/i, { timeout: 120_000 });
  // на сервер ушла извлечённая дорожка, а не исходное видео
  const uploaded = await page.evaluate(() => JSON.stringify(Reflect.get(window, "__uploaded")));
  expect(uploaded).toContain('"name":"hello.mka"');
  expect(uploaded).not.toContain("hello.mp4");
  await expect(page.locator("video")).toBeAttached();
});

test("запись с микрофона", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Записать с микрофона" }).click();
  const stop = page.getByRole("button", { name: /Остановить/ });
  await expect(stop).toBeVisible();
  await page.waitForTimeout(3000);
  await stop.click();
  await expect(page.getByRole("button", { name: "Распознать другой файл" })).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".result-title")).toHaveText(/^recording-\d{6}\.(webm|ogg|m4a)$/);
});
