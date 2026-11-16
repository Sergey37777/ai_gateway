import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { fakeApi, fakeStream, question } from "./fixtures";
import { QuestionPanel } from "./QuestionPanel";

type Props = ComponentProps<typeof QuestionPanel>;

function setup(overrides: Partial<Props> = {}, questions = [question("q1", "d1", "FOR UPDATE")]) {
  const fake = fakeApi([], questions);
  const stream = fakeStream();
  const handlers = {
    onClose: vi.fn<Props["onClose"]>(),
    onOpen: vi.fn<Props["onOpen"]>(),
    onCreated: vi.fn<Props["onCreated"]>(),
    onCountChange: vi.fn<Props["onCountChange"]>(),
    onQuoteClick: vi.fn<Props["onQuoteClick"]>(),
    onBusyChange: vi.fn<Props["onBusyChange"]>(),
  };
  const props: Props = {
    document: { id: "d1", title: "Спека", text: "текст" },
    draft: null,
    questionId: null,
    models: ["gemma4-12b"],
    deps: { ...fake.api, streamChat: stream.streamChat },
    ...handlers,
    ...overrides,
  };
  const view = render(<QuestionPanel {...props} />);
  return { fake, stream, handlers, view, props };
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("пустой список — подсказка", async () => {
  setup({}, []);
  expect(await screen.findByText(/Выделите непонятное место/)).toBeInTheDocument();
});

test("список вопросов: цитата; клик открывает вопрос", async () => {
  const { handlers } = setup();
  const item = await screen.findByRole("button", { name: /FOR UPDATE/ });
  await userEvent.click(item);
  expect(handlers.onOpen).toHaveBeenCalledWith("q1");
});

test("открытый вопрос: цитата и ответ; клик по цитате, удаление", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const { handlers, fake } = setup({ questionId: "q1" });
  expect(await screen.findByText("Это блокировка строки.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /«FOR UPDATE»/ }));
  expect(handlers.onQuoteClick).toHaveBeenCalledWith("FOR UPDATE");
  await userEvent.click(screen.getByRole("button", { name: "Удалить вопрос" }));
  expect(fake.api.deleteConversation).toHaveBeenCalledWith("q1");
  await vi.waitFor(() => {
    expect(handlers.onOpen).toHaveBeenCalledWith(null);
  });
  expect(handlers.onCountChange).toHaveBeenCalledWith(-1);
});

test("черновик → отправка: диалог с привязкой, стрим ответа", async () => {
  const user = userEvent.setup();
  const draft = { key: 1, quote: "replace_tail", context: "Раздел: Хранилище\n\nreplace_tail…" };
  const { fake, stream, handlers } = setup({ draft }, []);
  const form = await screen.findByRole("form", { name: "Новый вопрос" });
  expect(within(form).getByText("«replace_tail»")).toBeInTheDocument();
  const input = within(form).getByRole("textbox");
  expect(input).toHaveValue("Что это значит?");
  await user.click(within(form).getByRole("button", { name: "Спросить" }));
  await vi.waitFor(() => {
    expect(fake.api.createConversation).toHaveBeenCalledOnce();
  });
  expect(fake.api.createConversation.mock.calls[0]?.[0]).toMatchObject({
    title: "replace_tail",
    messages: [{ role: "user", text: "Что это значит?", images: [] }],
    document: { id: "d1", quote: "replace_tail", context: draft.context },
  });
  const body = stream.call(0).body;
  expect(body.messages[0]).toMatchObject({ role: "system" });
  expect(body.messages[1]).toEqual({
    role: "user",
    content: "Фрагмент:\n«replace_tail»\n\nВопрос: Что это значит?",
  });
  expect(handlers.onBusyChange).toHaveBeenCalledWith(true);
  stream.call(0).push({ event: { type: "content", text: "Замена хвоста." } });
  stream.call(0).push({ end: true });
  expect(await screen.findByText("Замена хвоста.")).toBeInTheDocument();
  expect(handlers.onCreated).toHaveBeenCalledWith("q-1");
  expect(handlers.onCountChange).toHaveBeenCalledWith(1);
  await vi.waitFor(() => {
    expect(fake.api.replaceTail).toHaveBeenCalled();
  });
});
