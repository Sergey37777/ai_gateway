import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { ConversationHeader } from "./ConversationHeader";

test("переименование: Enter сохраняет обрезанный текст, Esc отменяет, пустое не сохраняется", async () => {
  const user = userEvent.setup();
  const onRename = vi.fn<(title: string) => void>();
  render(
    <ConversationHeader
      title="Котики"
      saving={false}
      onRename={onRename}
      onDelete={() => undefined}
    />,
  );
  expect(screen.getByRole("heading", { name: "Котики" })).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Переименовать" }));
  const input = screen.getByRole("textbox", { name: "Название" });
  await user.clear(input);
  await user.keyboard("{Enter}");
  expect(onRename).not.toHaveBeenCalled();
  await user.type(input, "  Кошки  {Enter}");
  expect(onRename).toHaveBeenCalledExactlyOnceWith("Кошки");

  await user.click(screen.getByRole("button", { name: "Переименовать" }));
  await user.keyboard("{Escape}");
  expect(screen.getByRole("heading", { name: "Котики" })).toBeTruthy();
  expect(onRename).toHaveBeenCalledOnce();
});

test("удаление и пометка сохранения", async () => {
  const user = userEvent.setup();
  const onDelete = vi.fn<() => void>();
  render(
    <ConversationHeader title="Котики" saving onRename={() => undefined} onDelete={onDelete} />,
  );
  expect(screen.getByText("Сохранение…")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Удалить" }));
  expect(onDelete).toHaveBeenCalledOnce();
});
