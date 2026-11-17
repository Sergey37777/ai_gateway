import { describe, expect, test } from "vitest";
import { applyEdit, editStatus, hasEdits, locate, parseAnswer, revertEdit } from "./edits";

const BLOCK = [
  "Исправил опечатку:",
  "",
  "<<<<<<< SEARCH",
  "Превет, мир",
  "=======",
  "Привет, мир",
  ">>>>>>> REPLACE",
  "",
  "Готово.",
].join("\n");

describe("parseAnswer", () => {
  test("текст, блок, текст", () => {
    expect(parseAnswer(BLOCK)).toEqual([
      { kind: "text", text: "Исправил опечатку:\n" },
      { kind: "edit", edit: { search: "Превет, мир", replace: "Привет, мир", complete: true } },
      { kind: "text", text: "\nГотово." },
    ]);
  });

  test("ответ без правок — один текст", () => {
    expect(parseAnswer("Просто ответ")).toEqual([{ kind: "text", text: "Просто ответ" }]);
    expect(hasEdits("Просто ответ")).toBe(false);
    expect(hasEdits(BLOCK)).toBe(true);
  });

  test("многострочные блоки и пустой SEARCH", () => {
    const content = "<<<<<<< SEARCH\n=======\n## Итоги\n\nВсё.\n>>>>>>> REPLACE";
    expect(parseAnswer(content)).toEqual([
      { kind: "edit", edit: { search: "", replace: "## Итоги\n\nВсё.", complete: true } },
    ]);
  });

  test("стрим: незакрытый блок", () => {
    expect(parseAnswer("Сейчас\n<<<<<<< SEARCH\nстарое")).toEqual([
      { kind: "text", text: "Сейчас" },
      { kind: "edit", edit: { search: "старое", replace: "", complete: false } },
    ]);
    expect(parseAnswer("<<<<<<< SEARCH\nстарое\n=======\nнов")).toEqual([
      { kind: "edit", edit: { search: "старое", replace: "нов", complete: false } },
    ]);
  });

  test("ограда ``` вокруг блоков снимается", () => {
    const content = [
      "Правка:",
      "```markdown",
      "<<<<<<< SEARCH",
      "a",
      "=======",
      "b",
      ">>>>>>> REPLACE",
      "<<<<<<< НАЙТИ",
      "c",
      "=======",
      "d",
      ">>>>>>> ЗАМЕНИТЬ",
      "```",
      "Конец",
    ].join("\n");
    expect(parseAnswer(content)).toEqual([
      { kind: "text", text: "Правка:" },
      { kind: "edit", edit: { search: "a", replace: "b", complete: true } },
      { kind: "edit", edit: { search: "c", replace: "d", complete: true } },
      { kind: "text", text: "Конец" },
    ]);
  });

  test("обычный код в ответе не трогается", () => {
    const content = "```python\nprint(1)\n```";
    expect(parseAnswer(content)).toEqual([{ kind: "text", text: content }]);
  });
});

describe("locate", () => {
  test("точное совпадение и число вхождений", () => {
    expect(locate("abc abc", "abc")).toEqual({ count: 2, start: 0, end: 3 });
    expect(locate("x abc", "abc")).toEqual({ count: 1, start: 2, end: 5 });
    expect(locate("abc", "")).toEqual({ count: 0, start: -1, end: -1 });
  });

  test("построчно без учёта пробелов и крайних пустых строк", () => {
    const doc = "# Заголовок\n\n- пункт  один\n- пункт два\n\nТекст";
    const found = locate(doc, "\n-  пункт один \n- пункт два\n");
    expect(found.count).toBe(1);
    expect(doc.slice(found.start, found.end)).toBe("- пункт  один\n- пункт два");
  });
});

describe("applyEdit / revertEdit", () => {
  const doc = "# Документ\n\nПревет, мир\n\nКонец\n";

  test("замена", () => {
    const result = applyEdit(doc, { search: "Превет, мир", replace: "Привет, мир" });
    expect(result).toEqual({ ok: true, text: "# Документ\n\nПривет, мир\n\nКонец\n", at: 12 });
    if (!result.ok) return;
    expect(revertEdit(result.text, { search: "Превет, мир", replace: "Привет, мир" })).toEqual({
      ok: true,
      text: doc,
      at: 12,
    });
  });

  test("нет фрагмента и неоднозначный фрагмент", () => {
    expect(applyEdit(doc, { search: "нет такого", replace: "x" })).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(applyEdit("a\na\n", { search: "a", replace: "b" })).toEqual({
      ok: false,
      reason: "ambiguous",
    });
  });

  test("пустой SEARCH — дописать в конец и убрать обратно", () => {
    const result = applyEdit(doc, { search: "", replace: "\n## Итоги\n" });
    expect(result).toEqual({ ok: true, text: `${doc.trimEnd()}\n\n## Итоги\n`, at: 32 });
    expect(applyEdit("", { search: "", replace: "Текст" })).toEqual({
      ok: true,
      text: "Текст\n",
      at: 0,
    });
    if (!result.ok) return;
    expect(revertEdit(result.text, { search: "", replace: "\n## Итоги\n" })).toEqual({
      ok: true,
      text: doc,
      at: 30,
    });
  });

  test("удаление нельзя отменить обратной правкой", () => {
    expect(revertEdit("a", { search: "b", replace: "" })).toEqual({ ok: false, reason: "missing" });
  });
});

describe("editStatus", () => {
  const edit = { search: "Превет", replace: "Привет", complete: true };

  test("до и после применения", () => {
    expect(editStatus("Превет, мир", edit)).toBe("applicable");
    expect(editStatus("Привет, мир", edit)).toBe("applied");
    expect(editStatus("Другое", edit)).toBe("missing");
    expect(editStatus("Превет и Превет", edit)).toBe("ambiguous");
    expect(editStatus("Превет", { ...edit, complete: false })).toBe("pending");
    expect(editStatus("Превет", { ...edit, replace: "Превет" })).toBe("noop");
  });

  test("SEARCH внутри REPLACE: дописали после фрагмента", () => {
    const append = { search: "## Шаги", replace: "## Шаги\n\n1. Начать", complete: true };
    expect(editStatus("## Шаги\n", append)).toBe("applicable");
    expect(editStatus("## Шаги\n\n1. Начать\n", append)).toBe("applied");
  });

  test("пустой SEARCH", () => {
    const add = { search: "", replace: "Итоги", complete: true };
    expect(editStatus("Текст", add)).toBe("applicable");
    expect(editStatus("Текст\n\nИтоги\n", add)).toBe("applied");
    expect(editStatus("Текст", { ...add, replace: "" })).toBe("noop");
  });
});
