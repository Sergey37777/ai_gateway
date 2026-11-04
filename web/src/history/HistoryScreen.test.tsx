import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { TranscriptionPage } from "../api/types";
import { job } from "./fixtures";
import { HistoryScreen } from "./HistoryScreen";

type ListFn = (params: { q?: string; before?: string }) => Promise<TranscriptionPage>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(list: ListFn) {
  const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
  render(<HistoryScreen deps={{ listTranscriptions: list }} />);
  return { user };
}

test("список: название, ссылка на запись, метка API и статус", async () => {
  const list = vi.fn<ListFn>(() =>
    Promise.resolve({
      data: [
        job({ id: "a", title: "Совещание" }),
        job({ id: "b", title: "call.mp3", source: "api", status: "failed" }),
      ],
      next: null,
    }),
  );
  setup(list);
  const link = await screen.findByRole("link", { name: /Совещание/ });
  expect(link).toHaveAttribute("href", "#history/a");
  const api = screen.getByRole("link", { name: /call\.mp3/ });
  expect(within(api).getByText("API")).toBeInTheDocument();
  expect(within(api).getByText("Ошибка")).toBeInTheDocument();
  expect(list).toHaveBeenCalledWith({});
});

test("пустая история", async () => {
  setup(() => Promise.resolve({ data: [], next: null }));
  expect(await screen.findByText("Здесь появятся ваши распознавания")).toBeInTheDocument();
});

test("поиск уходит с задержкой и показывает «ничего не нашлось»", async () => {
  const list = vi.fn<ListFn>(() => Promise.resolve({ data: [], next: null }));
  const { user } = setup(list);
  await screen.findByText("Здесь появятся ваши распознавания");
  await user.type(screen.getByRole("searchbox", { name: "Поиск по истории" }), "план");
  expect(list).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(list).toHaveBeenLastCalledWith({ q: "план" });
  expect(await screen.findByText("Ничего не нашлось по запросу «план»")).toBeInTheDocument();
});

test("фрагмент совпадения показывается в результатах поиска", async () => {
  const list = vi.fn<ListFn>(() =>
    Promise.resolve({ data: [job({ snippet: "обсудили «план» на неделю" })], next: null }),
  );
  setup(list);
  expect(await screen.findByText("обсудили «план» на неделю")).toBeInTheDocument();
});

test("«Показать ещё» передаёт курсор и дописывает список", async () => {
  const list = vi
    .fn<ListFn>()
    .mockResolvedValueOnce({ data: [job({ id: "a", title: "Первая" })], next: "cur" })
    .mockResolvedValueOnce({ data: [job({ id: "b", title: "Вторая" })], next: null });
  const { user } = setup(list);
  await user.click(await screen.findByRole("button", { name: "Показать ещё" }));
  expect(list).toHaveBeenLastCalledWith({ before: "cur" });
  expect(await screen.findByRole("link", { name: /Вторая/ })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Первая/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Показать ещё" })).toBeNull();
});

test("активные записи опрашиваются раз в 3 секунды", async () => {
  const list = vi
    .fn<ListFn>()
    .mockResolvedValueOnce({
      data: [job({ id: "a", status: "running", progress: 0.2 })],
      next: null,
    })
    .mockResolvedValue({ data: [job({ id: "a", status: "done" })], next: null });
  setup(list);
  expect(await screen.findByText("Распознаётся — 20%")).toBeInTheDocument();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(await screen.findByText("Готово")).toBeInTheDocument();
  const calls = list.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(9000);
  });
  expect(list.mock.calls.length).toBe(calls);
});

test("ошибка загрузки — сообщение и повтор", async () => {
  const list = vi
    .fn<ListFn>()
    .mockRejectedValueOnce(new Error("База данных недоступна"))
    .mockResolvedValueOnce({ data: [], next: null });
  const { user } = setup(list);
  expect(await screen.findByRole("alert")).toHaveTextContent("База данных недоступна");
  await user.click(screen.getByRole("button", { name: "Повторить" }));
  expect(await screen.findByText("Здесь появятся ваши распознавания")).toBeInTheDocument();
});
