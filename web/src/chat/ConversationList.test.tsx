import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { listConversations } from "../api/conversations";
import { ApiError } from "../api/errors";
import type { ConversationItem, ConversationPage } from "../api/types";
import { ConversationList } from "./ConversationList";

function item(id: string, title: string, extra: Partial<ConversationItem> = {}): ConversationItem {
  return {
    id,
    title,
    model: "qwen3-0.6b",
    message_count: 2,
    created_at: "2026-11-08T10:00:00Z",
    updated_at: "2026-11-08T10:00:00Z",
    ...extra,
  };
}

type List = typeof listConversations;

function Harness({
  list,
  activeId = null,
  reloadKey = 0,
}: {
  list: List;
  activeId?: string | null;
  reloadKey?: number;
}) {
  const [items, setItems] = useState<ConversationItem[] | null>(null);
  return (
    <ConversationList
      activeId={activeId}
      items={items}
      onItemsChange={setItems}
      onNew={() => undefined}
      reloadKey={reloadKey}
      deps={{ listConversations: list }}
    />
  );
}

function page(data: ConversationItem[], next: string | null = null): ConversationPage {
  return { data, next };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

test("список: ссылки на диалоги, активный подсвечен", async () => {
  const list = vi.fn<List>().mockResolvedValue(page([item("a", "Котики"), item("b", "Собаки")]));
  render(<Harness list={list} activeId="b" />);
  const active = await screen.findByRole("link", { name: /Собаки/ });
  expect(active.getAttribute("href")).toBe("#chat/b");
  expect(active.getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("link", { name: /Котики/ }).getAttribute("aria-current")).toBeNull();
});

test("поиск: один запрос через 300 мс, снипет и пустой результат", async () => {
  const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
  const list = vi
    .fn<List>()
    .mockResolvedValueOnce(page([item("a", "Котики")]))
    .mockResolvedValueOnce(page([item("a", "Котики", { snippet: "про «котиков»" })]))
    .mockResolvedValueOnce(page([]));
  render(<Harness list={list} />);
  await screen.findByRole("link", { name: /Котики/ });
  await user.type(screen.getByRole("searchbox", { name: "Поиск по диалогам" }), "кот");
  expect(list).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(list).toHaveBeenCalledTimes(2);
  expect(list.mock.calls[1]?.[0]).toEqual({ q: "кот" });
  expect(await screen.findByText("про «котиков»")).toBeTruthy();
  await user.clear(screen.getByRole("searchbox", { name: "Поиск по диалогам" }));
  await user.type(screen.getByRole("searchbox", { name: "Поиск по диалогам" }), "пёс");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(await screen.findByText("Ничего не нашлось по запросу «пёс»")).toBeTruthy();
});

test("«Показать ещё» добавляет страницу по курсору", async () => {
  const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
  const list = vi
    .fn<List>()
    .mockResolvedValueOnce(page([item("a", "Первый")], "n1"))
    .mockResolvedValueOnce(page([item("b", "Второй")]));
  render(<Harness list={list} />);
  await user.click(await screen.findByRole("button", { name: "Показать ещё" }));
  expect(list.mock.calls[1]?.[0]).toEqual({ before: "n1" });
  expect(await screen.findByRole("link", { name: /Второй/ })).toBeTruthy();
  expect(screen.getByRole("link", { name: /Первый/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Показать ещё" })).toBeNull();
});

test("ошибка — баннер, «Повторить» перечитывает; reloadKey перечитывает список", async () => {
  const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
  const list = vi
    .fn<List>()
    .mockRejectedValueOnce(new ApiError("База данных недоступна", 503))
    .mockResolvedValue(page([item("a", "Котики")]));
  const view = render(<Harness list={list} />);
  expect(await screen.findByText(/База данных недоступна/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Повторить" }));
  expect(await screen.findByRole("link", { name: /Котики/ })).toBeTruthy();
  view.rerender(<Harness list={list} reloadKey={1} />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(list).toHaveBeenCalledTimes(3);
});
