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
  // чат после загрузки конфига ещё и читает список диалогов — считаем только конфиг
  expect(fetchMock.mock.calls.filter(([input]) => input === "/ui/config")).toHaveLength(2);
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

function stubRoutes(routes: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = routes[url];
      return Promise.resolve(
        body === undefined
          ? new Response(JSON.stringify({ error: { message: "нет" } }), { status: 404 })
          : new Response(JSON.stringify(body)),
      );
    }),
  );
}

test("вкладка «История» открывает поиск по истории", async () => {
  stubRoutes({ "/ui/config": CONFIG, "/api/transcriptions": { data: [], next: null } });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("tab", { name: "История" }));
  expect(window.location.hash).toBe("#history");
  expect(await screen.findByRole("searchbox", { name: "Поиск по истории" })).toBeInTheDocument();
});

test("#history/<id> открывает запись", async () => {
  window.location.hash = "#history/job-1";
  stubRoutes({
    "/ui/config": CONFIG,
    "/api/transcriptions/job-1": {
      id: "job-1",
      status: "queued",
      source: "ui",
      title: "Лекция",
      filename: "a.wav",
      model: "whisper-base",
      language: null,
      duration: null,
      progress: 0,
      queue_position: 1,
      error: null,
      has_audio: false,
      retryable: false,
      created_at: "2026-11-04T18:00:00Z",
      started_at: null,
      finished_at: null,
    },
  });
  render(<App />);
  expect(await screen.findByRole("heading", { name: "Лекция" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "История" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByText("В очереди: 1-я")).toBeInTheDocument();
});

test("#chat/<id> открывает вкладку «Чат» с сохранённым диалогом", async () => {
  window.location.hash = "#chat/c1";
  stubRoutes({
    "/ui/config": CONFIG,
    "/api/conversations": { data: [], next: null },
    "/api/conversations/c1": {
      id: "c1",
      title: "Сохранённый диалог",
      settings: {
        model: "qwen3-0.6b",
        system_prompt: "",
        temperature: null,
        max_tokens: null,
        reasoning_effort: null,
      },
      revision: 1,
      message_count: 1,
      created_at: "2026-11-08T10:00:00Z",
      updated_at: "2026-11-08T10:00:00Z",
      messages: [{ role: "user", text: "Вопрос из истории", images: [] }],
    },
  });
  render(<App />);
  expect(await screen.findByRole("heading", { name: "Сохранённый диалог" })).toBeInTheDocument();
  expect(screen.getByText("Вопрос из истории")).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Чат" })).toHaveAttribute("aria-selected", "true");
});
