import { expect, test } from "vitest";
import { buildRequest, type ChatSettings } from "./request";
import type { ChatMessage } from "./state";

const SETTINGS: ChatSettings = {
  model: "qwen3-0.6b",
  systemPrompt: "",
  temperature: null,
  maxTokens: null,
  reasoningEffort: null,
};

const HISTORY: ChatMessage[] = [
  { id: 0, role: "user", text: "Привет", images: [] },
  {
    id: 1,
    role: "assistant",
    content: "Здравствуйте",
    reasoning: "надо поздороваться",
    status: "done",
    usage: null,
    error: null,
  },
  {
    id: 2,
    role: "user",
    text: "Что на фото?",
    images: [{ name: "a.png", dataUrl: "data:image/png;base64,AAA" }],
  },
];

test("минимальный запрос", () => {
  const body = buildRequest(HISTORY, SETTINGS);
  expect(body).toEqual({
    model: "qwen3-0.6b",
    stream: true,
    stream_options: { include_usage: true },
    messages: [
      { role: "user", content: "Привет" },
      { role: "assistant", content: "Здравствуйте" },
      {
        role: "user",
        content: [
          { type: "text", text: "Что на фото?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        ],
      },
    ],
  });
});

test("системный промпт и параметры", () => {
  const body = buildRequest(HISTORY.slice(0, 1), {
    ...SETTINGS,
    systemPrompt: "  Отвечай кратко  ",
    temperature: 0.3,
    maxTokens: 256,
    reasoningEffort: "none",
  });
  expect(body.messages[0]).toEqual({ role: "system", content: "Отвечай кратко" });
  expect(body.temperature).toBe(0.3);
  expect(body.max_tokens).toBe(256);
  expect(body.reasoning_effort).toBe("none");
});

test("ответы с ошибкой и пустые остановленные не уходят в историю", () => {
  const history: ChatMessage[] = [
    { id: 0, role: "user", text: "1", images: [] },
    {
      id: 1,
      role: "assistant",
      content: "",
      reasoning: "",
      status: "error",
      usage: null,
      error: "x",
    },
    { id: 2, role: "user", text: "2", images: [] },
    {
      id: 3,
      role: "assistant",
      content: "",
      reasoning: "r",
      status: "stopped",
      usage: null,
      error: null,
    },
    { id: 4, role: "user", text: "3", images: [] },
    {
      id: 5,
      role: "assistant",
      content: "часть",
      reasoning: "",
      status: "stopped",
      usage: null,
      error: null,
    },
  ];
  expect(buildRequest(history, SETTINGS).messages).toEqual([
    { role: "user", content: "1" },
    { role: "user", content: "2" },
    { role: "user", content: "3" },
    { role: "assistant", content: "часть" },
  ]);
});
