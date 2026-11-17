import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageList } from "./MessageList";
import type { ChatMessage } from "./state";

function answer(content: string): ChatMessage[] {
  return [
    { id: 1, role: "user", text: "Вопрос", images: [] },
    {
      id: 2,
      role: "assistant",
      content,
      reasoning: "",
      status: "streaming",
      usage: null,
      error: null,
      model: null,
    },
  ];
}

/** Контейнер прокрутки с управляемой геометрией: в jsdom раскладки нет. */
function scrollBox() {
  const box = document.createElement("div");
  box.style.overflowY = "auto";
  document.body.append(box);
  const geometry = { scrollHeight: 2000, clientHeight: 500 };
  Object.defineProperty(box, "scrollHeight", { get: () => geometry.scrollHeight });
  Object.defineProperty(box, "clientHeight", { get: () => geometry.clientHeight });
  return { box, geometry };
}

function list(messages: ChatMessage[]) {
  return <MessageList messages={messages} busy onEdit={() => {}} onRegenerate={() => {}} />;
}

describe("MessageList: прокрутка за стримом", () => {
  it("у низа — докручивает контейнер до самого конца, а не до конца списка", () => {
    const { box, geometry } = scrollBox();
    box.scrollTop = 1500; // пользователь в самом низу
    const view = render(list(answer("начало")), { container: box });

    geometry.scrollHeight = 2300;
    view.rerender(list(answer("начало и продолжение")));

    // под списком сообщений ещё композер: выравнивание конца списка по низу окна
    // откатывало страницу вверх на его высоту
    expect(box.scrollTop).toBe(2300);
    box.remove();
  });

  it("пользователь ушёл читать выше — не тянет вниз", () => {
    const { box, geometry } = scrollBox();
    box.scrollTop = 1500;
    const view = render(list(answer("начало")), { container: box });

    box.scrollTop = 600;
    fireEvent.scroll(box);
    geometry.scrollHeight = 2300;
    view.rerender(list(answer("начало и продолжение")));

    expect(box.scrollTop).toBe(600);
    box.remove();
  });

  it("вернулся вниз во время стрима — снова следует за ответом", () => {
    const { box, geometry } = scrollBox();
    box.scrollTop = 600;
    const view = render(list(answer("начало")), { container: box });

    box.scrollTop = 1500;
    fireEvent.scroll(box);
    geometry.scrollHeight = 2300;
    view.rerender(list(answer("начало и продолжение")));

    expect(box.scrollTop).toBe(2300);
    box.remove();
  });
});
