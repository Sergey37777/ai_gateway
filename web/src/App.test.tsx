import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App";
import { clearApiKey, getApiKey, notifyUnauthorized } from "./api/apiKey";
import type { UiConfig } from "./api/types";

const CONFIG: UiConfig = {
  max_upload_mb: 200,
  auth_required: false,
  default_transcription: "whisper-base",
  models: [
    { id: "whisper-base", kind: "transcription" },
    { id: "qwen3-0.6b", kind: "chat" },
  ],
  languages: [{ code: "ru", name: "russian" }],
};

function stubConfig(config: UiConfig): void {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify(config)))),
  );
}

beforeEach(() => {
  window.location.hash = "";
  clearApiKey();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("после загрузки конфига видны вкладки, #chat открывает чат", async () => {
  stubConfig(CONFIG);
  const user = userEvent.setup();
  render(<App />);
  expect(await screen.findByRole("tab", { name: "Распознавание" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.click(screen.getByRole("tab", { name: "Чат" }));
  expect(window.location.hash).toBe("#chat");
  expect(screen.getByRole("tab", { name: "Чат" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tabpanel", { name: "Чат" })).toBeVisible();
});

test("ошибка загрузки конфига — сообщение и повтор", async () => {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValueOnce(new Response(JSON.stringify(CONFIG)));
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<App />);
  expect(
    await screen.findByText("Шлюз недоступен. Проверьте, что сервис запущен"),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Повторить" }));
  expect(await screen.findByRole("tab", { name: "Чат" })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("auth_required без ключа — диалог, ключ сохраняется", async () => {
  stubConfig({ ...CONFIG, auth_required: true });
  const user = userEvent.setup();
  render(<App />);
  const input = await screen.findByLabelText("API-ключ");
  await user.type(input, "k-123");
  await user.click(screen.getByRole("button", { name: "Сохранить" }));
  expect(getApiKey()).toBe("k-123");
  expect(window.localStorage.getItem("aigw.apiKey")).toBe("k-123");
  expect(screen.queryByLabelText("API-ключ")).not.toBeInTheDocument();
});

test("401 от API — ключ сбрасывается, диалог «Ключ не подошёл»", async () => {
  stubConfig({ ...CONFIG, auth_required: true });
  window.localStorage.setItem("aigw.apiKey", "old");
  render(<App />);
  await screen.findByRole("tab", { name: "Чат" });
  expect(screen.queryByLabelText("API-ключ")).not.toBeInTheDocument();
  act(() => {
    notifyUnauthorized();
  });
  expect(screen.getByText("Ключ не подошёл")).toBeInTheDocument();
  expect(getApiKey()).toBeNull();
});
