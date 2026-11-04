import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { isActive, usePolling } from "./poll";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test("isActive", () => {
  expect(isActive("queued")).toBe(true);
  expect(isActive("running")).toBe(true);
  expect(isActive("done")).toBe(false);
  expect(isActive("failed")).toBe(false);
  expect(isActive("cancelled")).toBe(false);
});

test("usePolling вызывает fn с интервалом, пока включён, и не накладывает вызовы", async () => {
  const pending: (() => void)[] = [];
  const release = () => {
    pending.shift()?.();
  };
  const fn = vi.fn<() => Promise<void>>(
    () =>
      new Promise((resolve) => {
        pending.push(resolve);
      }),
  );
  const { rerender, unmount } = renderHook(
    ({ on }) => {
      usePolling(fn, 1000, on);
    },
    { initialProps: { on: true } },
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(fn).toHaveBeenCalledTimes(1);
  // первый вызов не завершён — второго нет
  await vi.advanceTimersByTimeAsync(3000);
  expect(fn).toHaveBeenCalledTimes(1);
  release();
  await vi.advanceTimersByTimeAsync(1000);
  expect(fn).toHaveBeenCalledTimes(2);
  release();
  rerender({ on: false });
  await vi.advanceTimersByTimeAsync(5000);
  expect(fn).toHaveBeenCalledTimes(2);
  unmount();
});
