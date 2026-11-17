import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { listDocuments } from "../api/documents";
import type { DocumentItem } from "../api/types";
import { DocumentList } from "./DocumentList";
import { doc } from "./fixtures";

type List = typeof listDocuments;

function item(id: string, overrides: Partial<DocumentItem> = {}): DocumentItem {
  const { text: _text, ...meta } = doc(id);
  return { ...meta, ...overrides };
}

function Harness({ list, onUpload }: { list: List; onUpload: (files: File[]) => void }) {
  const [items, setItems] = useState<DocumentItem[] | null>(null);
  return (
    <DocumentList
      activeId="d1"
      items={items}
      onItemsChange={setItems}
      reloadKey={0}
      onNew={vi.fn<() => void>()}
      onUpload={onUpload}
      uploading={null}
      uploadErrors={[{ name: "bad.md", message: "Файл не в UTF-8" }]}
      uploadNotes={[]}
      deps={{ listDocuments: list }}
    />
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

test("элементы: название, размер, число вопросов, активный; ошибки загрузки", async () => {
  const list = vi.fn<List>(() =>
    Promise.resolve({
      data: [item("d1", { chars: 24_890, question_count: 3 }), item("d2", { title: "Заметки" })],
      next: null,
    }),
  );
  render(<Harness list={list} onUpload={vi.fn<(files: File[]) => void>()} />);
  const active = await screen.findByRole("link", { name: /Спека/ });
  expect(active).toHaveAttribute("aria-current", "page");
  expect(active).toHaveAttribute("href", "#documents/d1");
  expect(active).toHaveTextContent("25 тыс. знаков");
  expect(active).toHaveTextContent("3 вопроса");
  expect(screen.getByRole("link", { name: /Заметки/ })).not.toHaveAttribute("aria-current");
  expect(screen.getByText("bad.md: Файл не в UTF-8")).toBeInTheDocument();
});

test("поиск с задержкой и «Показать ещё»", async () => {
  const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
  const list = vi.fn<List>((params) =>
    Promise.resolve(
      params.before === undefined
        ? { data: [item("d1", { snippet: "«кот»" })], next: "n1" }
        : { data: [item("d2", { title: "Второй" })], next: null },
    ),
  );
  render(<Harness list={list} onUpload={vi.fn<(files: File[]) => void>()} />);
  await screen.findByText("«кот»");
  await user.type(screen.getByRole("searchbox"), "кот");
  act(() => {
    vi.advanceTimersByTime(300);
  });
  await vi.waitFor(() => {
    expect(list).toHaveBeenLastCalledWith({ q: "кот" });
  });
  await user.click(screen.getByRole("button", { name: "Показать ещё" }));
  expect(await screen.findByRole("link", { name: /Второй/ })).toBeInTheDocument();
});

test("выбор файлов передаёт их родителю", async () => {
  const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
  const onUpload = vi.fn<(files: File[]) => void>();
  render(<Harness list={() => Promise.resolve({ data: [], next: null })} onUpload={onUpload} />);
  const file = new File(["# x"], "a.md");
  await user.upload(screen.getByLabelText("Загрузить файлы"), file);
  expect(onUpload).toHaveBeenCalledWith([file]);
  expect(await screen.findByText(/Документов пока нет/)).toBeInTheDocument();
});
