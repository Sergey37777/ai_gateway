import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { parseRoute } from "../route";
import { DocumentsScreen } from "./DocumentsScreen";
import { CONFIG, doc, fakeApi, fakeStream, question } from "./fixtures";
import type { SourceEditor } from "./SourceEditor";

// CodeMirror в jsdom не набирает текст: исходник подменяется полем ввода
vi.mock("./SourceEditor", () => ({
  SourceEditor: (props: Parameters<typeof SourceEditor>[0]) => (
    <textarea
      aria-label="Исходник документа"
      value={props.value}
      readOnly={props.readOnly}
      onChange={(event) => {
        props.onChange(event.target.value);
      }}
    />
  ),
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn<(config: unknown) => void>(),
    render: vi.fn<(id: string, code: string) => Promise<{ svg: string }>>(() =>
      Promise.resolve({ svg: "<svg></svg>" }),
    ),
  },
}));

function Harness({ deps }: { deps: NonNullable<Parameters<typeof DocumentsScreen>[0]["deps"]> }) {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onHash = () => {
      setRoute(parseRoute(window.location.hash));
    };
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
    };
  }, []);
  return (
    <DocumentsScreen
      config={CONFIG}
      onDirtyChange={vi.fn<(dirty: boolean) => void>()}
      documentId={route.documentId}
      questionId={route.questionId}
      visible
      deps={deps}
    />
  );
}

function setup(
  hash: string,
  documents = [doc("d1")],
  questions = [question("q1", "d1", "FOR UPDATE")],
) {
  window.location.hash = hash;
  const fake = fakeApi(documents, questions);
  const stream = fakeStream();
  const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
  render(<Harness deps={{ ...fake.api, streamChat: stream.streamChat }} />);
  return { fake, stream, user };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  window.localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.location.hash = "";
});

test("открытие документа: превью, оглавление, список слева", async () => {
  setup("#documents/d1");
  const preview = await screen.findByTestId("doc-preview");
  expect(await within(preview).findByRole("heading", { name: "Хранилище" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 2, name: "Спека" })).toBeInTheDocument();
  const outline = screen.getByRole("navigation", { name: "Оглавление" });
  expect(within(outline).getByRole("button", { name: "Хранилище" })).toBeInTheDocument();
  expect(await screen.findByRole("link", { name: /Спека/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("нет документа → «Документ не найден»", async () => {
  setup("#documents/нет");
  expect(await screen.findByText(/Документ не найден/)).toBeInTheDocument();
});

test("«Новый документ» создаёт пустой и открывает его рядом с исходником", async () => {
  const { fake, user } = setup("#documents", [], []);
  await user.click(await screen.findByRole("button", { name: "Новый документ" }));
  expect(fake.api.createDocument).toHaveBeenCalledWith({
    title: "Без названия",
    filename: "Без названия.md",
    format: "markdown",
    text: "",
  });
  await waitFor(() => {
    expect(window.location.hash).toBe("#documents/doc-1");
  });
  expect(await screen.findByLabelText("Исходник документа")).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "Рядом" })).toBeChecked();
});

test("загрузка: удачный файл создаётся и открывается, ошибка — в списке", async () => {
  const { fake, user } = setup("#documents", [], []);
  const good = new File(["# Привет\n\nмир"], "good.md");
  const bad = new File([new Uint8Array([0xcf, 0xf0, 0xe8])], "bad.md");
  await user.upload(await screen.findByLabelText("Загрузить файлы"), [good, bad]);
  await waitFor(() => {
    expect(fake.api.createDocument).toHaveBeenCalledOnce();
  });
  expect(fake.api.createDocument.mock.calls[0]?.[0]).toMatchObject({
    title: "good",
    text: "# Привет\n\nмир",
  });
  expect(await screen.findByText("bad.md: Файл не в UTF-8")).toBeInTheDocument();
  await waitFor(() => {
    expect(window.location.hash).toBe("#documents/doc-1");
  });
});

test("правка → автосохранение через 1,5 с; конфликт → плашка и «Скачать мою версию»", async () => {
  const { fake, user } = setup("#documents/d1");
  await user.click(await screen.findByRole("radio", { name: "Исходник" }));
  const editor = screen.getByLabelText("Исходник документа");
  await user.type(editor, "!");
  act(() => {
    vi.advanceTimersByTime(1500);
  });
  await waitFor(() => {
    expect(fake.api.writeText).toHaveBeenCalledOnce();
  });
  expect(await screen.findByText("Сохранено")).toBeInTheDocument();
  // документ изменили в другой вкладке
  const current = fake.documents.get("d1");
  if (current === undefined) throw new Error("нет документа");
  fake.documents.set("d1", { ...current, revision: 9 });
  await user.type(editor, "?");
  act(() => {
    vi.advanceTimersByTime(1500);
  });
  expect(await screen.findByText("Документ изменён в другой вкладке")).toBeInTheDocument();
  expect(screen.getByLabelText("Исходник документа")).toHaveAttribute("readonly");
  const createObjectURL = vi.fn<(blob: Blob) => string>(() => "blob:x");
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn<() => void>() }),
  );
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  await user.click(screen.getByRole("button", { name: "Скачать мою версию" }));
  expect(click).toHaveBeenCalled();
  const blob = createObjectURL.mock.calls[0]?.[0];
  expect(await blob?.text()).toContain("транзакции.\n!?");
});

test("переименование и удаление с вопросами", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const { fake, user } = setup("#documents/d1");
  await user.click(await screen.findByRole("button", { name: "Переименовать" }));
  const input = screen.getByRole("textbox", { name: "Название" });
  await user.clear(input);
  await user.type(input, "Итоги{Enter}");
  expect(fake.api.renameDocument).toHaveBeenCalledWith("d1", "Итоги");
  expect(await screen.findByRole("heading", { level: 2, name: "Итоги" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Удалить" }));
  expect(window.confirm).toHaveBeenCalledWith("Удалить документ «Итоги» и 1 вопрос?");
  await waitFor(() => {
    expect(fake.api.deleteDocument).toHaveBeenCalledWith("d1");
  });
  await waitFor(() => {
    expect(window.location.hash).toBe("#documents");
  });
});

test("выделение в превью → «Спросить» → черновик с цитатой и контекстом", async () => {
  const { fake, user } = setup("#documents/d1", [doc("d1")], []);
  const preview = await screen.findByTestId("doc-preview");
  const paragraph = await within(preview).findByText("replace_tail в одной транзакции.");
  const text = paragraph.firstChild;
  if (text === null) throw new Error("нет текста");
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, "replace_tail".length);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  // клик сбросил бы выделение: отпускание кнопки мыши после выделения
  fireEvent.mouseUp(paragraph);
  await user.click(await screen.findByRole("button", { name: "Спросить модель" }));
  const form = await screen.findByRole("form", { name: "Новый вопрос" });
  expect(within(form).getByText("«replace_tail»")).toBeInTheDocument();
  await user.click(within(form).getByRole("button", { name: "Спросить" }));
  await waitFor(() => {
    expect(fake.api.createConversation).toHaveBeenCalledOnce();
  });
  const body = fake.api.createConversation.mock.calls[0]?.[0];
  expect(body?.document?.quote).toBe("replace_tail");
  expect(body?.document?.context).toContain("Раздел: Спека › Хранилище");
  await waitFor(() => {
    expect(window.location.hash).toBe("#documents/d1/q-1");
  });
});

test("после отправки закрытие и открытие панели показывает список, а не старый черновик", async () => {
  const { fake, stream, user } = setup("#documents/d1", [doc("d1")], []);
  const preview = await screen.findByTestId("doc-preview");
  const paragraph = await within(preview).findByText("replace_tail в одной транзакции.");
  const text = paragraph.firstChild;
  if (text === null) throw new Error("нет текста");
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, "replace_tail".length);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  fireEvent.mouseUp(paragraph);
  await user.click(await screen.findByRole("button", { name: "Спросить модель" }));
  const form = await screen.findByRole("form", { name: "Новый вопрос" });
  await user.click(within(form).getByRole("button", { name: "Спросить" }));
  await waitFor(() => {
    expect(fake.api.createConversation).toHaveBeenCalledOnce();
  });
  stream.call(0).push({ end: true });
  await user.click(screen.getByRole("button", { name: "Закрыть вопросы" }));
  await user.click(screen.getByRole("button", { name: /Вопросы/ }));
  expect(await screen.findByRole("button", { name: /«replace_tail»/ })).toBeInTheDocument();
  expect(screen.queryByRole("form", { name: "Новый вопрос" })).toBeNull();
});
