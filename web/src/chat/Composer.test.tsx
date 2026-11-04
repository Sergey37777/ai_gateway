import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { Composer } from "./Composer";
import type { ImageAttachment } from "./state";

type OnSend = (text: string, images: ImageAttachment[]) => void;

function setup(
  readImage = vi.fn<(file: File) => Promise<ImageAttachment>>((file: File) =>
    Promise.resolve({ name: file.name, dataUrl: "data:image/png;base64,AAA" }),
  ),
) {
  const onSend = vi.fn<OnSend>();
  const user = userEvent.setup();
  render(
    <Composer
      disabled={false}
      streaming={false}
      onSend={onSend}
      onStop={() => undefined}
      readImage={readImage}
    />,
  );
  return { onSend, user, readImage, input: screen.getByLabelText("Сообщение") };
}

test("Enter отправляет, Shift+Enter — перенос строки", async () => {
  const { onSend, user, input } = setup();
  await user.type(input, "строка 1{Shift>}{Enter}{/Shift}строка 2");
  expect(onSend).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  expect(onSend).toHaveBeenCalledWith("строка 1\nстрока 2", []);
  expect(input).toHaveValue("");
});

test("двойной Enter — одна отправка", async () => {
  const { onSend, user, input } = setup();
  await user.type(input, "раз");
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onSend).toHaveBeenCalledOnce();
});

test("пустое сообщение не отправляется", async () => {
  const { onSend, user, input } = setup();
  await user.type(input, "   {Enter}");
  expect(onSend).not.toHaveBeenCalled();
});

test("вставка текста не перехватывается", () => {
  const { input, readImage } = setup();
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.assign(event, {
    clipboardData: {
      items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
      files: [],
    },
  });
  input.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(readImage).not.toHaveBeenCalled();
});

test("вставка картинки добавляет миниатюру", async () => {
  const { input, onSend, user, readImage } = setup();
  const png = new File(["x"], "shot.png", { type: "image/png" });
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.assign(event, {
    clipboardData: {
      items: [{ kind: "file", type: "image/png", getAsFile: () => png }],
      files: [png],
    },
  });
  input.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(await screen.findByRole("img", { name: "shot.png" })).toBeInTheDocument();
  expect(readImage).toHaveBeenCalledWith(png);
  await user.click(input);
  await user.keyboard("{Enter}");
  expect(onSend).toHaveBeenCalledWith("", [
    { name: "shot.png", dataUrl: "data:image/png;base64,AAA" },
  ]);
});

test("во время стрима — кнопка «Стоп»", async () => {
  const onStop = vi.fn<() => void>();
  const user = userEvent.setup();
  render(<Composer disabled={false} streaming onSend={() => undefined} onStop={onStop} />);
  await user.click(screen.getByRole("button", { name: "Стоп" }));
  expect(onStop).toHaveBeenCalledOnce();
});
