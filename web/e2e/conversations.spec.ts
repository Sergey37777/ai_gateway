import { expect, test } from "@playwright/test";

/**
 * Диалог сохраняется и без Ollama: ответ с ошибкой тоже часть истории, поэтому сценарий
 * от доступности LLM не зависит.
 */
test("диалоги: сохранение, перезагрузка, поиск, переименование, удаление", async ({ page }) => {
  await page.goto("/#chat");
  const panel = page.getByRole("tabpanel", { name: "Чат" });
  const input = panel.getByLabel("Сообщение");
  await input.fill("Проверка котиков");
  await input.press("Enter");
  await expect(page).toHaveURL(/#chat\/[0-9a-f-]+$/);
  // ответ (или ошибка без Ollama) завершён и сохранён
  await expect(panel.getByRole("button", { name: /Перегенерировать|Повторить/ })).toBeVisible({
    timeout: 120_000,
  });
  await expect(panel.getByText("Сохранение…")).toHaveCount(0);

  await page.reload();
  await expect(page).toHaveURL(/#chat\/[0-9a-f-]+$/);
  await expect(panel.getByText("Проверка котиков", { exact: true }).first()).toBeVisible();
  await expect(panel.getByRole("heading", { name: "Проверка котиков" })).toBeVisible();

  await panel.getByRole("searchbox", { name: "Поиск по диалогам" }).fill("котик");
  await expect(panel.getByRole("link", { name: /Проверка котиков/ })).toBeVisible();

  await panel.getByRole("button", { name: "Переименовать" }).click();
  const title = panel.getByRole("textbox", { name: "Название" });
  await title.fill("Диалог e2e");
  await title.press("Enter");
  await expect(panel.getByRole("heading", { name: "Диалог e2e" })).toBeVisible();
  await expect(panel.getByRole("link", { name: /Диалог e2e/ })).toBeVisible();

  page.once("dialog", (dialog) => {
    void dialog.accept();
  });
  await panel.getByRole("button", { name: "Удалить" }).click();
  await expect(page).toHaveURL(/#chat$/);
  const search = panel.getByRole("searchbox", { name: "Поиск по диалогам" });
  await search.fill("");
  await search.fill("котик");
  await expect(panel.getByText("Ничего не нашлось по запросу «котик»")).toBeVisible();
});
