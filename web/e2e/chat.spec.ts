import { expect, test } from "@playwright/test";

const MODEL = "qwen3-0.6b";

test("чат: ответ стримом и перегенерация", async ({ page, request }) => {
  const config = await (await request.get("/ui/config")).text();
  const health = await (await request.get("/health")).text();
  test.skip(!config.includes(`"id":"${MODEL}"`), `в models.dev.yaml нет ${MODEL}`);
  test.skip(!health.includes('"ollama":"ok"'), "Ollama недоступна (docker start ollama-dev)");

  await page.goto("/#chat");
  // обе вкладки смонтированы — ищем внутри панели чата
  const panel = page.getByRole("tabpanel", { name: "Чат" });
  await panel.getByLabel("Модель").selectOption(MODEL);
  await panel.getByText("Настройки").click();
  await panel.getByLabel("Рассуждения").selectOption("none");
  const input = panel.getByLabel("Сообщение");
  await input.fill("Ответь одним словом: столица Франции?");
  await input.press("Enter");
  await expect(panel.getByRole("button", { name: "Перегенерировать" })).toBeVisible({
    timeout: 120_000,
  });
  await expect(panel.locator(".message-assistant .markdown")).not.toBeEmpty();
  await expect(panel.getByRole("alert")).toHaveCount(0);
});
