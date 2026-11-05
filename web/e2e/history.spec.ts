import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const HELLO_WAV = fileURLToPath(new URL("../../tests/fixtures/hello.wav", import.meta.url));

test("история: поиск, переименование, удаление", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Аудио или видео файл").setInputFiles(HELLO_WAV);
  await expect(page.locator(".transcript-text")).toContainText(/hello/i, { timeout: 120_000 });
  // аудио из истории (Opus с сервера) после перезагрузки страницы
  await page.reload();
  await expect(page.locator("audio")).toBeAttached();

  await page.getByRole("button", { name: "Переименовать" }).click();
  const title = page.getByRole("textbox", { name: "Название" });
  await title.fill("Проверка истории");
  await title.press("Enter");
  await expect(page.getByRole("heading", { name: "Проверка истории" })).toBeVisible();

  await page.getByRole("tab", { name: "История" }).click();
  await page.getByRole("searchbox", { name: "Поиск по истории" }).fill("hello");
  const item = page.getByRole("link", { name: /Проверка истории/ });
  await expect(item).toBeVisible();
  await expect(item).toContainText("«Hello»");

  await item.click();
  page.once("dialog", (dialog) => {
    void dialog.accept();
  });
  await page.getByRole("button", { name: "Удалить" }).click();
  await expect(page).toHaveURL(/#history$/);
  await page.getByRole("searchbox", { name: "Поиск по истории" }).fill("hello");
  await expect(page.getByText("Ничего не нашлось по запросу «hello»")).toBeVisible();
});
