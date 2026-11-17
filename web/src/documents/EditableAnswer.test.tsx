import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { EditableAnswer } from "./EditableAnswer";

const DOC = "# Заметки\n\nПревет, мир\n\nКонец\n";

function block(search: string, replace: string): string {
  return `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;
}

function setup(content: string, doc = DOC, canApply = true) {
  const onApply = vi.fn<(text: string, at: number) => void>();
  const view = render(
    <EditableAnswer content={content} doc={doc} canApply={canApply} onApply={onApply} />,
  );
  return { onApply, view };
}

test("ответ без правок — обычный Markdown", () => {
  setup("**Жирный** ответ");
  expect(screen.getByText("Жирный").tagName).toBe("STRONG");
  expect(screen.queryByRole("group")).toBeNull();
});

test("карточка: разница и «Применить»", async () => {
  const { onApply } = setup(`Исправил опечатку.\n${block("Превет, мир", "Привет, мир")}`);
  expect(screen.getByText("Исправил опечатку.")).toBeInTheDocument();
  const card = screen.getByRole("group", { name: "Правка документа" });
  expect(within(card).getByText("Превет,", { selector: "del" })).toBeInTheDocument();
  expect(within(card).getByText("Привет,", { selector: "ins" })).toBeInTheDocument();
  await userEvent.click(within(card).getByRole("button", { name: "Применить" }));
  expect(onApply).toHaveBeenCalledWith("# Заметки\n\nПривет, мир\n\nКонец\n", 11);
});

test("применённая правка: «Отменить» — обратная правка", async () => {
  const applied = "# Заметки\n\nПривет, мир\n\nКонец\n";
  const { onApply } = setup(block("Превет, мир", "Привет, мир"), applied);
  const card = screen.getByRole("group", { name: "Правка документа" });
  expect(within(card).getByText("Правка применена")).toBeInTheDocument();
  await userEvent.click(within(card).getByRole("button", { name: "Отменить" }));
  expect(onApply).toHaveBeenCalledWith(DOC, 11);
});

test("фрагмент не найден / встречается дважды — без кнопки", () => {
  setup(`${block("Нет такого", "x")}\n\n${block("Конец", "y")}`, `${DOC}Конец\n`);
  const [missing, ambiguous] = screen.getAllByRole("group", { name: "Правка документа" });
  expect(missing).toHaveTextContent(/Фрагмент не найден/);
  expect(ambiguous).toHaveTextContent(/встречается в документе несколько раз/);
  expect(screen.queryByRole("button", { name: "Применить" })).toBeNull();
});

test("стрим: незакрытый блок — «пишет правку», применить нельзя", () => {
  setup("<<<<<<< SEARCH\nПревет, мир\n=======\nПри");
  expect(screen.getByText("Модель пишет правку…")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Применить" })).toBeNull();
});

test("«Применить все» — последовательно, одним изменением", async () => {
  const content = `${block("Превет", "Привет")}\n${block("Конец", "Финал")}`;
  const { onApply } = setup(content);
  await userEvent.click(screen.getByRole("button", { name: "Применить все правки (2)" }));
  expect(onApply).toHaveBeenCalledOnce();
  expect(onApply).toHaveBeenCalledWith("# Заметки\n\nПривет, мир\n\nФинал\n", 11);
});

test("конфликт документа — кнопки недоступны", () => {
  setup(block("Превет", "Привет"), DOC, false);
  expect(screen.getByRole("button", { name: "Применить" })).toBeDisabled();
});

test("пустой SEARCH — «Дописать в конец документа»", async () => {
  const { onApply } = setup(block("", "## Итоги"));
  expect(screen.getByText("Дописать в конец документа")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Применить" }));
  expect(onApply).toHaveBeenCalledWith("# Заметки\n\nПревет, мир\n\nКонец\n\n## Итоги\n", 31);
});
