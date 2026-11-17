import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";

const SAMPLE = fileURLToPath(new URL("fixtures/sample.md", import.meta.url));
const ARTICLE = fileURLToPath(new URL("fixtures/article.pdf", import.meta.url));
const NOTES = fileURLToPath(new URL("fixtures/notes.docx", import.meta.url));

async function upload(page: Page) {
  await page.goto("/#documents");
  const panel = page.getByRole("tabpanel", { name: "Документы" });
  await panel.getByLabel("Загрузить файлы").setInputFiles(SAMPLE);
  await expect(page).toHaveURL(/#documents\/[0-9a-f-]+$/);
  return panel;
}

/** Без Ollama ответ приходит с ошибкой и тоже сохраняется: сценарий от LLM не зависит. */
test("документы: превью, правка с автосохранением, вопрос по выделению", async ({ page }) => {
  const panel = await upload(page);
  const preview = panel.getByTestId("doc-preview");

  await expect(preview.getByRole("heading", { name: "Таблица" })).toBeVisible();
  await expect(preview.locator("table td").first()).toHaveText("id");
  await expect(preview.locator(".doc-mermaid svg")).toBeVisible({ timeout: 30_000 });
  await expect(preview.locator(".katex").first()).toBeVisible();
  await expect(preview.locator(".katex-display")).toBeVisible();
  await expect(preview.locator('input[type="checkbox"]')).toHaveCount(2);
  await expect(preview.locator(".footnotes")).toContainText("Так работает replace_tail.");

  // якорная ссылка и оглавление не меняют адрес
  const url = page.url();
  await preview.getByRole("link", { name: "ссылка на итоги" }).click();
  expect(page.url()).toBe(url);
  await panel
    .getByRole("navigation", { name: "Оглавление" })
    .getByRole("button", { name: "Формулы" })
    .click();
  expect(page.url()).toBe(url);

  // «Рядом»: правка в CodeMirror видна в превью и сохраняется
  await panel.getByText("Рядом", { exact: true }).click();
  const editor = panel.getByRole("textbox", { name: "Исходник документа" });
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\n\nДобавлено в e2e.");
  await expect(preview.getByText("Добавлено в e2e.")).toBeVisible();
  await expect(panel.getByText("Сохранено")).toBeVisible({ timeout: 10_000 });
  await page.reload();
  await expect(panel.getByTestId("doc-preview").getByText("Добавлено в e2e.")).toBeVisible();

  // выделить фрагмент → «Спросить модель» → вопрос сохранён
  const target = panel
    .getByTestId("doc-preview")
    .getByText("Блокировка строки FOR UPDATE", { exact: false });
  await target.selectText();
  await panel.getByTestId("doc-preview").dispatchEvent("mouseup");
  await page.getByRole("button", { name: "Спросить модель" }).click();
  const form = panel.getByRole("form", { name: "Новый вопрос" });
  await expect(form.getByRole("textbox", { name: "Вопрос" })).toHaveValue("Что это значит?");
  await form.getByRole("button", { name: "Спросить" }).click();
  await expect(page).toHaveURL(/#documents\/[0-9a-f-]+\/[0-9a-f-]+$/);
  const questions = panel.getByRole("complementary", { name: "Вопросы к документу" });
  await expect(questions.getByRole("button", { name: /Перегенерировать|Повторить/ })).toBeVisible({
    timeout: 120_000,
  });
  await page.reload();
  await expect(questions.getByText("Что это значит?", { exact: true })).toBeVisible();
  await expect(
    questions.getByRole("button", { name: /«Блокировка строки FOR UPDATE/ }),
  ).toBeVisible();
  await expect(panel.getByRole("link", { name: /Спецификация e2e|sample/ })).toContainText(
    "1 вопрос",
  );
});

test("документы: правка из двух вкладок → конфликт, удаление вместе с вопросами", async ({
  page,
  context,
}) => {
  const panel = await upload(page);
  const address = page.url();
  await panel.getByText("Исходник", { exact: true }).click();

  const other = await context.newPage();
  await other.goto(address);
  const otherPanel = other.getByRole("tabpanel", { name: "Документы" });
  await otherPanel.getByText("Исходник", { exact: true }).click();
  await otherPanel.getByRole("textbox", { name: "Исходник документа" }).click();
  await other.keyboard.type("из второй вкладки ");
  await expect(otherPanel.getByText("Сохранено")).toBeVisible({ timeout: 10_000 });
  await expect(otherPanel.getByText("Сохраняется…")).toHaveCount(0, { timeout: 10_000 });

  await panel.getByRole("textbox", { name: "Исходник документа" }).click();
  await page.keyboard.type("из первой ");
  await expect(panel.getByText("Документ изменён в другой вкладке")).toBeVisible({
    timeout: 10_000,
  });
  await expect(panel.getByRole("button", { name: "Скачать мою версию" })).toBeVisible();
  await other.close();

  page.on("dialog", (dialog) => {
    void dialog.accept();
  });
  await panel.getByRole("button", { name: "Загрузить заново" }).click();
  await expect(panel.getByText("Документ изменён в другой вкладке")).toHaveCount(0);
  await panel.getByRole("button", { name: "Удалить" }).click();
  await expect(page).toHaveURL(/#documents$/);
});

test("документы: архив .zip — документ на каждый текстовый файл", async ({ page }) => {
  const stamp = String(Date.now());
  const archive = zipSync({
    [`e2e-${stamp}/readme.md`]: strToU8(`# Архив ${stamp}\n\nИз архива.`),
    [`e2e-${stamp}/Заметки/итоги.txt`]: strToU8("итоги"),
    [`e2e-${stamp}/logo.png`]: new Uint8Array([1, 2, 3]),
  });
  await page.goto("/#documents");
  const panel = page.getByRole("tabpanel", { name: "Документы" });
  await panel.getByLabel("Загрузить файлы").setInputFiles({
    name: "notes.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(archive),
  });
  await expect(
    panel.getByText("Из архива notes.zip: 2 документа, пропущено 1 файл других типов"),
  ).toBeVisible();
  await expect(page).toHaveURL(/#documents\/[0-9a-f-]+$/);
  await expect(panel.getByRole("link", { name: /^Заметки\/итоги/ }).first()).toBeVisible();
  await panel
    .getByRole("link", { name: /^readme/ })
    .first()
    .click();
  await expect(panel.getByTestId("doc-preview").getByText("Из архива.")).toBeVisible();
});

test("документы: PDF и DOCX становятся Markdown", async ({ page }) => {
  await page.goto("/#documents");
  const panel = page.getByRole("tabpanel", { name: "Документы" });
  await panel.getByLabel("Загрузить файлы").setInputFiles([ARTICLE, NOTES]);
  await expect(page).toHaveURL(/#documents\/[0-9a-f-]+$/);
  // последним открывается DOCX; название PDF — из самого файла, а не из имени
  await expect(
    panel.getByTestId("doc-preview").getByRole("heading", { name: "Notes Heading" }),
  ).toBeVisible();
  await expect(panel.getByTestId("doc-preview").getByText("Hello from DOCX")).toBeVisible();
  await panel
    .getByRole("link", { name: /^Stage Six Article/ })
    .first()
    .click();
  const preview = panel.getByTestId("doc-preview");
  await expect(preview.getByRole("heading", { name: "Stage Six Article" })).toBeVisible();
  await expect(
    preview.getByText("The first paragraph of the article is split across two lines in the PDF."),
  ).toBeVisible();
});
