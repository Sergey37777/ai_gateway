import { render } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { SourceEditor } from "./SourceEditor";

const noop = () => undefined;

test("показывает текст, принимает новый value и режим только чтения", () => {
  const onChange = vi.fn<(text: string) => void>();
  const { container, rerender } = render(
    <SourceEditor
      value={"# Заголовок\n\nтекст"}
      readOnly={false}
      onChange={onChange}
      onSelection={noop}
      onTopLine={noop}
    />,
  );
  const content = container.querySelector(".cm-content");
  expect(content?.textContent).toContain("# Заголовок");
  expect(content).toHaveAttribute("contenteditable", "true");
  rerender(
    <SourceEditor
      value="другой документ"
      readOnly
      onChange={onChange}
      onSelection={noop}
      onTopLine={noop}
    />,
  );
  expect(container.querySelector(".cm-content")?.textContent).toBe("другой документ");
  expect(container.querySelector(".cm-content")).toHaveAttribute("contenteditable", "false");
  // смена value снаружи — не правка пользователя
  expect(onChange).not.toHaveBeenCalled();
});
