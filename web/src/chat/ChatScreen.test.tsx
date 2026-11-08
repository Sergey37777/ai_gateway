import { render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import userEvent from "@testing-library/user-event";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatEvent } from "../api/chat";
import { ApiError } from "../api/errors";
import type { UiConfig } from "../api/types";
import type { ApiChatSettings, Conversation } from "../api/types";
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

const SETTINGS: ApiChatSettings = {
  model: "qwen3-0.6b",
  system_prompt: "",
  temperature: null,
  max_tokens: null,
  reasoning_effort: null,
};

const STAMP = "2026-11-08T10:00:00Z";

function stored(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: "Сохранённый",
    settings: SETTINGS,
    revision: 0,
    message_count: 2,
    created_at: STAMP,
    updated_at: STAMP,
    messages: [
      { role: "user", text: "Старый вопрос", images: [] },
      {
        role: "assistant",
        text: "Старый ответ",
        reasoning: "",
        status: "done",
        error: null,
        usage: null,
        model: "qwen3-0.6b",
      },
    ],
    ...overrides,
  };
}

function notFound(): ApiError {
  return new ApiError("Диалог не найден", 404, "conversation_not_found");
}

/** API диалогов в памяти с семантикой сервера (revision → 409, нет диалога → 404). */
function fakeConversations(initial: Conversation[] = []) {
  const store = new Map(initial.map((c) => [c.id, c]));
  let created = 0;
  const find = (id: string): Conversation => {
    const found = store.get(id);
    if (found === undefined) throw notFound();
    return found;
  };
  const api = {
    listConversations: vi.fn<Api["listConversations"]>(() =>
      Promise.resolve({
        data: [...store.values()].map((c) => ({
          id: c.id,
          title: c.title,
          model: c.settings.model,
          message_count: c.messages.length,
          created_at: c.created_at,
          updated_at: c.updated_at,
        })),
        next: null,
      }),
    ),
    getConversation: vi.fn<Api["getConversation"]>((id) => Promise.resolve().then(() => find(id))),
    createConversation: vi.fn<Api["createConversation"]>((body) => {
      created += 1;
      const conversation: Conversation = {
        ...body,
        id: `new-${String(created)}`,
        revision: 0,
        message_count: body.messages.length,
        created_at: STAMP,
        updated_at: STAMP,
      };
      store.set(conversation.id, conversation);
      return Promise.resolve(conversation);
    }),
    replaceTail: vi.fn<Api["replaceTail"]>((id, from, body) =>
      Promise.resolve().then(() => {
        const current = find(id);
        if (current.revision !== body.revision) {
          throw new ApiError("Диалог изменён", 409, "conversation_conflict");
        }
        const messages = [...current.messages.slice(0, from), ...body.messages];
        const next = { ...current, messages, revision: current.revision + 1 };
        store.set(id, next);
        return { revision: next.revision, updated_at: STAMP, message_count: messages.length };
      }),
    ),
    patchConversation: vi.fn<Api["patchConversation"]>((id, body) =>
      Promise.resolve().then(() => {
        const next = { ...find(id), ...body };
        store.set(id, next);
        return next;
      }),
    ),
    deleteConversation: vi.fn<Api["deleteConversation"]>((id) =>
      Promise.resolve().then(() => {
        find(id);
        store.delete(id);
      }),
    ),
  };
  return { api, store };
}

type Api = Required<NonNullable<ComponentProps<typeof ChatScreen>["deps"]>>;

function setup(options: { conversationId?: string | null; conversations?: Conversation[] } = {}) {
  const fake = fakeStream();
  const conversations = fakeConversations(options.conversations);
  const onDirtyChange = vi.fn<(dirty: boolean) => void>();
  const user = userEvent.setup();
  const props = (conversationId: string | null) => (
    <ChatScreen
      config={CONFIG}
      onDirtyChange={onDirtyChange}
      conversationId={conversationId}
      visible
      deps={{ streamChat: fake.streamChat, ...conversations.api }}
    />
  );
  const view = render(props(options.conversationId ?? null));
  const navigate = (conversationId: string | null) => {
    view.rerender(props(conversationId));
  };
  return { ...fake, ...conversations, user, onDirtyChange, navigate };
}

async function send(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByLabelText("Сообщение"), text);
  await user.keyboard("{Enter}");
}

test("отправка, стрим, markdown и перегенерация", async () => {
  const { user, call, calls, onDirtyChange } = setup();
  await send(user, "Привет");
  expect(screen.getByText("Привет", { selector: ".message-text" })).toBeInTheDocument();
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
  // ответ сохранён — уход со страницы ничего не теряет
  await waitFor(() => {
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

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

beforeEach(() => {
  window.location.hash = "#chat";
  try {
    window.localStorage.clear();
  } catch {
    // хранилище может быть недоступно — тесты от него не зависят
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

test("первая отправка создаёт диалог, ответ дописывается, адрес — #chat/<id>", async () => {
  const { user, call, calls, api, onDirtyChange } = setup();
  await send(user, "Привет\nвторая строка");
  await waitFor(() => {
    expect(api.createConversation).toHaveBeenCalledOnce();
  });
  expect(api.createConversation.mock.calls[0]?.[0]).toMatchObject({
    title: "Привет",
    settings: SETTINGS,
    messages: [{ role: "user", text: "Привет\nвторая строка", images: [] }],
  });
  await waitFor(() => {
    expect(window.location.hash).toBe("#chat/new-1");
  });
  await waitFor(() => {
    expect(calls).toHaveLength(1);
  });
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  call(0).push({ event: { type: "content", text: "Здравствуйте" } });
  call(0).push({ end: true });
  await waitFor(() => {
    expect(api.replaceTail).toHaveBeenCalledOnce();
  });
  expect(api.replaceTail.mock.calls[0]).toEqual([
    "new-1",
    1,
    {
      revision: 0,
      messages: [
        expect.objectContaining({ text: "Здравствуйте", status: "done", model: "qwen3-0.6b" }),
      ],
    },
  ]);
  await waitFor(() => {
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });
  expect(api.getConversation).not.toHaveBeenCalled();
  expect(await screen.findByRole("heading", { name: "Привет" })).toBeInTheDocument();
  expect(await screen.findByRole("link", { name: /Привет/ })).toBeInTheDocument();
});

test("открытие сохранённого диалога восстанавливает сообщения и настройки", async () => {
  const conversation = stored("c1", { settings: { ...SETTINGS, system_prompt: "Кратко" } });
  setup({ conversationId: "c1", conversations: [conversation] });
  expect(screen.getByText("Загрузка…")).toBeInTheDocument();
  expect(await screen.findByText("Старый ответ")).toBeInTheDocument();
  expect(screen.getByText("Старый вопрос")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Сохранённый" })).toBeInTheDocument();
  expect(screen.getByLabelText<HTMLTextAreaElement>("Системный промпт").value).toBe("Кратко");
});

test("модели из диалога нет — выбрана первая доступная с пометкой", async () => {
  setup({
    conversationId: "c1",
    conversations: [stored("c1", { settings: { ...SETTINGS, model: "gone-model" } })],
  });
  expect(
    await screen.findByText("Модель gone-model недоступна, выбрана qwen3-0.6b"),
  ).toBeInTheDocument();
  expect(screen.getByLabelText<HTMLSelectElement>("Модель").value).toBe("qwen3-0.6b");
});

test("продолжение диалога с картинкой отправляет её в LLM", async () => {
  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
  const conversation = stored("c1", {
    messages: [
      { role: "user", text: "Что это?", images: [{ name: "cat.png", data_url: dataUrl }] },
      ...stored("c1").messages.slice(1),
    ],
  });
  const { user, calls, call } = setup({ conversationId: "c1", conversations: [conversation] });
  await screen.findByText("Старый ответ");
  await send(user, "А ещё?");
  await waitFor(() => {
    expect(calls).toHaveLength(1);
  });
  expect(call(0).body.messages[0]).toEqual({
    role: "user",
    content: [
      { type: "text", text: "Что это?" },
      { type: "image_url", image_url: { url: dataUrl } },
    ],
  });
});

test("«Стоп» сразу: пустой остановленный ответ сохраняется и не уходит в LLM", async () => {
  const { user, calls, call, api } = setup({ conversationId: "c1", conversations: [stored("c1")] });
  await screen.findByText("Старый ответ");
  await send(user, "Вопрос");
  await waitFor(() => {
    expect(calls).toHaveLength(1);
  });
  await user.click(screen.getByRole("button", { name: "Стоп" }));
  await waitFor(() => {
    expect(api.replaceTail).toHaveBeenCalledTimes(2);
  });
  expect(api.replaceTail.mock.calls[1]?.[2].messages).toEqual([
    expect.objectContaining({ role: "assistant", text: "", status: "stopped" }),
  ]);
  await send(user, "Ещё");
  await waitFor(() => {
    expect(calls).toHaveLength(2);
  });
  expect(call(1).body.messages).toEqual([
    { role: "user", content: "Старый вопрос" },
    { role: "assistant", content: "Старый ответ" },
    { role: "user", content: "Вопрос" },
    { role: "user", content: "Ещё" },
  ]);
});

test("409 — плашка, отправка заблокирована, «Загрузить заново» перечитывает", async () => {
  const { user, calls, call, api, store } = setup({
    conversationId: "c1",
    conversations: [stored("c1")],
  });
  await screen.findByText("Старый ответ");
  // другая вкладка успела записать
  const other = stored("c1", { revision: 5 });
  store.set("c1", other);
  await send(user, "Вопрос");
  expect(await screen.findByText("Диалог изменён в другой вкладке")).toBeInTheDocument();
  await waitFor(() => {
    expect(calls).toHaveLength(1);
  });
  call(0).push({ end: true });
  expect(screen.getByLabelText("Сообщение")).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Загрузить заново" }));
  await waitFor(() => {
    expect(api.getConversation).toHaveBeenCalledTimes(2);
  });
  await waitFor(() => {
    expect(screen.queryByText("Диалог изменён в другой вкладке")).not.toBeInTheDocument();
  });
  expect(screen.queryByText("Вопрос")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Сообщение")).toBeEnabled();
});

test("сбой записи — «Не сохранено» и «Повторить»", async () => {
  const { user, api } = setup({ conversationId: "c1", conversations: [stored("c1")] });
  await screen.findByText("Старый ответ");
  api.replaceTail.mockRejectedValueOnce(
    new ApiError("База данных недоступна", 503, "database_unavailable"),
  );
  await send(user, "Вопрос");
  expect(await screen.findByText(/Не сохранено: База данных недоступна/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Повторить сохранение" }));
  await waitFor(() => {
    expect(screen.queryByText(/Не сохранено/)).not.toBeInTheDocument();
  });
  expect(api.replaceTail).toHaveBeenCalledTimes(2);
});

test("переключение диалога во время стрима сохраняет обрезанный ответ", async () => {
  const { user, calls, call, api, navigate } = setup({
    conversationId: "c1",
    conversations: [stored("c1"), stored("c2", { title: "Второй", messages: [] })],
  });
  await screen.findByText("Старый ответ");
  await send(user, "Вопрос");
  await waitFor(() => {
    expect(calls).toHaveLength(1);
  });
  call(0).push({ event: { type: "content", text: "Начало" } });
  await screen.findByText("Начало");
  navigate("c2");
  await waitFor(() => {
    expect(call(0).signal.aborted).toBe(true);
  });
  expect(await screen.findByRole("heading", { name: "Второй" })).toBeInTheDocument();
  const saved = api.replaceTail.mock.calls.flatMap((c) => c[2].messages);
  expect(saved).toContainEqual(
    expect.objectContaining({ role: "assistant", text: "Начало", status: "stopped" }),
  );
});

test("диалога нет — «Диалог не найден» и ссылка на новый чат", async () => {
  setup({ conversationId: "missing" });
  expect(await screen.findByText(/Диалог не найден/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Новый чат" }).getAttribute("href")).toBe("#chat");
});

test("переименование и удаление", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const { user, api } = setup({ conversationId: "c1", conversations: [stored("c1")] });
  await screen.findByText("Старый ответ");
  await user.click(screen.getByRole("button", { name: "Переименовать" }));
  const input = screen.getByRole("textbox", { name: "Название" });
  await user.clear(input);
  await user.type(input, "Новое название{Enter}");
  await waitFor(() => {
    expect(api.patchConversation).toHaveBeenCalledWith("c1", { title: "Новое название" });
  });
  expect(await screen.findByRole("heading", { name: "Новое название" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Удалить" }));
  await waitFor(() => {
    expect(api.deleteConversation).toHaveBeenCalledWith("c1");
  });
  await waitFor(() => {
    expect(window.location.hash).toBe("#chat");
  });
  expect(screen.queryByText("Старый ответ")).not.toBeInTheDocument();
});
