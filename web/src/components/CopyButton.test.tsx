import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { CopyButton } from "./CopyButton";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("без navigator.clipboard копирует через execCommand", async () => {
  const user = userEvent.setup();
  // userEvent ставит свой clipboard — убираем, чтобы проверить fallback небезопасного контекста
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  const exec = vi.fn<(command: string) => boolean>(() => true);
  Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
  render(<CopyButton text="привет" />);
  await user.click(screen.getByRole("button", { name: "Копировать" }));
  expect(exec).toHaveBeenCalledWith("copy");
  expect(await screen.findByRole("button", { name: "Скопировано" })).toBeInTheDocument();
});
