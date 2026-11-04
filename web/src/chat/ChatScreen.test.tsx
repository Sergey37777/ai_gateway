import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions";
import { expect, test, vi } from "vitest";
import type { ChatEvent } from "../api/chat";
import { ApiError } from "../api/errors";
import type { UiConfig } from "../api/types";
import { ChatScreen } from "./ChatScreen";

const CONFIG: UiConfig = {
  max_upload_mb: 200,
  auth_required: false,
  default_transcription: "whisper-base",
  models: [
    { id: "whisper-base", kind: "transcription" },
    { id: "qwen3-0.6b", kind: "chat" },
    { id: "qwen2.5vl-3b", kind: "chat" },
  ],
  languages: [],
};

type Step = { event: ChatEvent } | { end: true } | { error: unknown };

/** Управляемый streamChat: тест сам подаёт события каждого вызова. */
function fakeStream() {
  const calls: {
    body: ChatCompletionCreateParamsStreaming;
    signal: AbortSignal;
    push: (step: Step) => void;
  }[] = [];
  const streamChat = (body: ChatCompletionCreateParamsStreaming, signal: AbortSignal) => {
    const queue: Step[] = [];
    let wake: (() => void) | null = null;
    const push = (step: Step) => {
      queue.push(step);
      wake?.();
    };
    calls.push({ body, signal, push });
    signal.addEventListener("abort", () => {
      push({ error: new DOMException("Aborted", "AbortError") });
    });
    return (async function* (): AsyncGenerator<ChatEvent> {
      for (;;) {
        const step = queue.shift();
        if (step === undefined) {
          // oxlint-disable-next-line no-await-in-loop -- события подаются тестом по одному
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        if ("end" in step) return;
        if ("error" in step) throw step.error;
        yield step.event;
      }
    })();
  };
  const call = (index: number) => {
    const c = calls[index];
    if (c === undefined) throw new Error(`нет вызова ${String(index)}`);
    return c;
  };
  return { streamChat, calls, call };
}

function setup() {
  const fake = fakeStream();
  const onDirtyChange = vi.fn<(dirty: boolean) => void>();
  const user = userEvent.setup();
  render(
    <ChatScreen
      config={CONFIG}
      onDirtyChange={onDirtyChange}
      deps={{ streamChat: fake.streamChat }}
    />,
  );
  return { ...fake, user, onDirtyChange };
}

async function send(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByLabelText("Сообщение"), text);
  await user.keyboard("{Enter}");
}

test("отправка, стрим, markdown и перегенерация", async () => {
  const { user, call, calls, onDirtyChange } = setup();
  await send(user, "Привет");
  expect(screen.getByText("Привет")).toBeInTheDocument();
  await waitFor(() => {
    expect(calls).toHaveLength(1);
  });
  expect(call(0).body.model).toBe("qwen3-0.6b");
  call(0).push({ event: { type: "content", text: "Здравствуй, **мир**" } });
  expect(await screen.findByText("мир", { selector: "strong" })).toBeInTheDocument();
  call(0).push({ event: { type: "usage", usage: { prompt_tokens: 5, completion_tokens: 7 } } });
  call(0).push({ end: true });
  expect(await screen.findByRole("button", { name: "Перегенерировать" })).toBeInTheDocument();
  expect(screen.getByText("запрос 5 · ответ 7 токенов")).toBeInTheDocument();
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);

  await user.click(screen.getByRole("button", { name: "Перегенерировать" }));
  await waitFor(() => {
    expect(calls).toHaveLength(2);
  });
  expect(call(1).body.messages).toEqual([{ role: "user", content: "Привет" }]);
});

test("стоп прерывает запрос и помечает ответ", async () => {
  const { user, call, calls } = setup();
  await send(user, "Долгий ответ");
  await waitFor(() => {
    expect(calls).toHaveLength(1);
  });
  call(0).push({ event: { type: "content", text: "Начало" } });
  await screen.findByText("Начало");
  await user.click(screen.getByRole("button", { name: "Стоп" }));
  expect(call(0).signal.aborted).toBe(true);
  expect(await screen.findByText("остановлено")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Отправить" })).toBeInTheDocument();
});

test("рассуждения — в свёрнутом блоке", async () => {
  const { user, call, calls } = setup();
  await send(user, "Подумай");
  await waitFor(() => {
    expect(calls).toHaveLength(1);
  });
  call(0).push({ event: { type: "reasoning", text: "размышляю о вопросе" } });
  call(0).push({ event: { type: "content", text: "Ответ" } });
  call(0).push({ end: true });
  const summary = await screen.findByText("Размышления");
  const details = summary.closest("details");
  if (details === null) throw new Error("нет <details>");
  expect(details.open).toBe(false);
  expect(within(details).getByText("размышляю о вопросе")).toBeInTheDocument();
});

test("ошибка — сообщение и «Повторить»", async () => {
  const { user, call, calls } = setup();
  await send(user, "?");
  await waitFor(() => {
    expect(calls).toHaveLength(1);
  });
  call(0).push({ error: new ApiError("Ollama недоступна", 503, "model_unavailable", 30) });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Ollama недоступна. Повторите через 30 с",
  );
  await user.click(screen.getByRole("button", { name: "Повторить" }));
  await waitFor(() => {
    expect(calls).toHaveLength(2);
  });
});

test("правка сообщения отправляет историю до него", async () => {
  const { user, call, calls } = setup();
  await send(user, "Первый");
  await waitFor(() => {
    expect(calls).toHaveLength(1);
  });
  call(0).push({ event: { type: "content", text: "Ответ 1" } });
  call(0).push({ end: true });
  await screen.findByText("Ответ 1");
  await send(user, "Второй");
  await waitFor(() => {
    expect(calls).toHaveLength(2);
  });
  call(1).push({ end: true });
  await waitFor(() => {
    expect(screen.getAllByRole("button", { name: "Изменить" })[0]).toBeEnabled();
  });

  const [firstEdit] = screen.getAllByRole("button", { name: "Изменить" });
  if (firstEdit === undefined) throw new Error("нет кнопки «Изменить»");
  await user.click(firstEdit);
  const editor = screen.getByLabelText("Изменить сообщение");
  await user.clear(editor);
  await user.type(editor, "Первый исправлен");
  await user.click(screen.getByRole("button", { name: "Сохранить и отправить" }));
  await waitFor(() => {
    expect(calls).toHaveLength(3);
  });
  expect(call(2).body.messages).toEqual([{ role: "user", content: "Первый исправлен" }]);
  expect(screen.queryByText("Второй")).not.toBeInTheDocument();
});

test("сырой HTML в ответе не рендерится", async () => {
  const { user, call, calls } = setup();
  await send(user, "html");
  await waitFor(() => {
    expect(calls).toHaveLength(1);
  });
  call(0).push({
    event: {
      type: "content",
      text: 'Текст <script>alert(1)</script> <img src=x onerror="alert(2)">',
    },
  });
  call(0).push({ end: true });
  await screen.findByRole("button", { name: "Перегенерировать" });
  expect(document.querySelector(".chat-messages script")).toBeNull();
  expect(document.querySelector(".chat-messages img")).toBeNull();
});

test("настройки уходят в запрос", async () => {
  const { user, call, calls } = setup();
  await user.selectOptions(screen.getByLabelText("Модель"), "qwen2.5vl-3b");
  await user.click(screen.getByText("Настройки"));
  await user.type(screen.getByLabelText("Системный промпт"), "Кратко");
  await user.type(screen.getByLabelText("Температура"), "0.2");
  await user.type(screen.getByLabelText("Макс. токенов"), "100");
  await user.selectOptions(screen.getByLabelText("Рассуждения"), "none");
  await send(user, "?");
  await waitFor(() => {
    expect(calls).toHaveLength(1);
  });
  expect(call(0).body).toMatchObject({
    model: "qwen2.5vl-3b",
    temperature: 0.2,
    max_tokens: 100,
    reasoning_effort: "none",
    messages: [
      { role: "system", content: "Кратко" },
      { role: "user", content: "?" },
    ],
  });
});
