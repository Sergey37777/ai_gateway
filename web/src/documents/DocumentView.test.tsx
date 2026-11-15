import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { DocumentView } from "./DocumentView";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn<(config: unknown) => void>(),
    render: vi.fn<(id: string, code: string) => Promise<{ svg: string }>>((_id, code) =>
      code.includes("сломано")
        ? Promise.reject(new Error("Parse error on line 1"))
        : Promise.resolve({ svg: `<svg data-testid="diagram"><text>${code.length}</text></svg>` }),
    ),
  },
}));

afterEach(() => {
  window.location.hash = "";
});

function view(text: string, onAnchor?: (id: string) => void) {
  return render(
    <DocumentView text={text} format="markdown" {...(onAnchor !== undefined && { onAnchor })} />,
  );
}

test("GFM: таблица, чекбокс, зачёркивание, сноска", () => {
  const text = [
    "| A | B |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "- [x] готово",
    "- [ ] нет",
    "",
    "~~старое~~ и сноска[^1]",
    "",
    "[^1]: Текст сноски.",
  ].join("\n");
  const { container } = view(text);
  expect(container.querySelector("table td")?.textContent).toBe("1");
  const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect([...boxes].map((b) => [b.checked, b.disabled])).toEqual([
    [true, true],
    [false, true],
  ]);
  expect(container.querySelector("del")?.textContent).toBe("старое");
  expect(screen.getByText("Текст сноски.", { exact: false })).toBeInTheDocument();
});

test("HTML: безопасное остаётся, скрипты и обработчики вырезаны", () => {
  const text = [
    "<details><summary>Подробнее</summary>скрыто</details>",
    "",
    '<img src="x" onerror="alert(1)" alt="картинка">',
    "",
    "<script>window.hacked = true</script>",
    "",
    "[ссылка](javascript:alert(1)) <kbd>Ctrl</kbd>",
  ].join("\n");
  const { container } = view(text);
  expect(container.querySelector("details summary")?.textContent).toBe("Подробнее");
  expect(container.querySelector("kbd")?.textContent).toBe("Ctrl");
  expect(container.querySelector("script")).toBeNull();
  expect(container.innerHTML).not.toContain("onerror");
  expect(container.innerHTML).not.toContain("javascript:");
});

test("якорная ссылка прокручивает к заголовку и не меняет адрес", async () => {
  const onAnchor = vi.fn<(id: string) => void>();
  const scroll = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
  Element.prototype.scrollIntoView = scroll;
  window.location.hash = "#documents/d1";
  view("[к итогам](#итоги)\n\n## Итоги\n\nконец", onAnchor);
  await userEvent.click(screen.getByRole("link", { name: "к итогам" }));
  expect(onAnchor).toHaveBeenCalledWith("итоги");
  expect(scroll).toHaveBeenCalled();
  expect(window.location.hash).toBe("#documents/d1");
  expect(screen.getByRole("heading", { name: "Итоги" })).toHaveAttribute("id", "итоги");
});

test("внешняя ссылка — в новой вкладке, относительная — неактивна", () => {
  view("[сайт](https://example.com) и [файл](./other.md)");
  expect(screen.getByRole("link", { name: "сайт" })).toHaveAttribute("target", "_blank");
  expect(screen.queryByRole("link", { name: "файл" })).toBeNull();
  expect(screen.getByText("файл")).toHaveAttribute("title", "Файл не загружен");
});

test("относительная картинка — рамка с alt, data: и https — как есть", () => {
  const { container } = view(
    "![схема](./img/scheme.png)\n\n![лого](https://example.com/a.png)\n\n![точка](data:image/png;base64,AA)",
  );
  expect(container.querySelector(".doc-image-missing")?.textContent).toContain("схема");
  expect(screen.getByAltText("лого")).toHaveAttribute("src", "https://example.com/a.png");
  expect(screen.getByAltText("точка")).toHaveAttribute("src", "data:image/png;base64,AA");
});

test("формулы KaTeX и доллары в тексте не ломают рендер", () => {
  const { container } = view(
    "Энергия $E = mc^2$.\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nЦена $5 и $10 за штуку.",
  );
  expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
  expect(container.querySelector(".katex-display")).not.toBeNull();
  expect(container.textContent).toContain("за штуку");
});

test("Mermaid: диаграмма рисуется, ошибка — код и сообщение", async () => {
  view("```mermaid\ngraph TD; A-->B\n```\n\n```mermaid\nсломано\n```");
  expect(await screen.findByTestId("diagram")).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getByText(/Parse error on line 1/)).toBeInTheDocument();
  });
  expect(screen.getByText("сломано")).toBeInTheDocument();
});

test("код подсвечивается и копируется кнопкой", () => {
  const { container } = view("```python\nprint('привет')\n```");
  expect(container.querySelector("code.hljs, code.language-python")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Копировать" })).toBeInTheDocument();
});

test("блоки получают смещения исходника", () => {
  const text = "# Заголовок\n\nПервый абзац.\n\nВторой абзац.";
  const { container } = view(text);
  const second = [...container.querySelectorAll("p")].find(
    (p) => p.textContent === "Второй абзац.",
  );
  expect(second?.dataset["srcStart"]).toBe(String(text.indexOf("Второй")));
  expect(second?.dataset["srcEnd"]).toBe(String(text.length));
});

test("обычный текст — без разметки", () => {
  const { container } = render(<DocumentView text={"# не заголовок\n*как есть*"} format="text" />);
  expect(container.querySelector("h1")).toBeNull();
  expect(container.querySelector("pre.doc-plain")?.textContent).toBe("# не заголовок\n*как есть*");
});
