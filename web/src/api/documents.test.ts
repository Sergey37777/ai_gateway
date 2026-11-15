import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  parseDocument,
  renameDocument,
  writeText,
} from "./documents";
import { ApiError } from "./errors";

const META = {
  id: "d1",
  title: "Спека",
  filename: "spec.md",
  format: "markdown",
  chars: 12,
  revision: 3,
  question_count: 2,
  created_at: "2026-11-15T10:00:00Z",
  updated_at: "2026-11-15T10:01:00Z",
};
const DOCUMENT = { ...META, text: "# Спека\n\nтекст" };

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
let fetchMock: ReturnType<typeof vi.fn<FetchFn>>;

function respond(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function lastCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1);
  if (call === undefined) throw new Error("fetch не вызывался");
  return { url: call[0], init: call[1] ?? {} };
}

function bodyOf(init: RequestInit): unknown {
  if (typeof init.body !== "string") throw new Error("тело — не строка");
  return JSON.parse(init.body);
}

beforeEach(() => {
  fetchMock = vi.fn<FetchFn>();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

test("parseDocument: корректный документ", () => {
  expect(parseDocument(DOCUMENT)).toEqual(DOCUMENT);
});

test.each([
  ["нет text", META],
  ["формат html", { ...DOCUMENT, format: "html" }],
  ["chars строкой", { ...DOCUMENT, chars: "12" }],
])("parseDocument отвергает: %s", (_name, value) => {
  expect(parseDocument(value)).toBeNull();
});

test("listDocuments: поиск, курсор и разбор", async () => {
  fetchMock.mockResolvedValue(
    respond(200, { data: [{ ...META, snippet: "«кот»" }, { bogus: 1 }], next: "n1" }),
  );
  const page = await listDocuments({ q: "кот", before: "c0" });
  expect(lastCall().url).toBe("/api/documents?q=%D0%BA%D0%BE%D1%82&before=c0");
  expect(page).toEqual({ data: [{ ...META, snippet: "«кот»" }], next: "n1" });
});

test("getDocument и createDocument", async () => {
  fetchMock.mockResolvedValue(respond(200, DOCUMENT));
  expect((await getDocument("d 1")).text).toBe(DOCUMENT.text);
  expect(lastCall().url).toBe("/api/documents/d%201");
  fetchMock.mockResolvedValue(respond(201, DOCUMENT));
  const body = { title: "Спека", filename: "spec.md", format: "markdown" as const, text: "x" };
  await createDocument(body);
  const { url, init } = lastCall();
  expect(init.method).toBe("POST");
  expect(url).toBe("/api/documents");
  expect(bodyOf(init)).toEqual(body);
});

test("renameDocument, writeText, deleteDocument", async () => {
  fetchMock.mockResolvedValue(respond(200, { ...META, title: "Новое" }));
  expect((await renameDocument("d1", "Новое")).title).toBe("Новое");
  expect(lastCall().init.method).toBe("PATCH");
  expect(bodyOf(lastCall().init)).toEqual({ title: "Новое" });
  fetchMock.mockResolvedValue(
    respond(200, { revision: 4, updated_at: "2026-11-15T10:02:00Z", chars: 5 }),
  );
  const result = await writeText("d1", { revision: 3, text: "новый" });
  expect(lastCall().url).toBe("/api/documents/d1/text");
  expect(lastCall().init.method).toBe("PUT");
  expect(result).toEqual({ revision: 4, updated_at: "2026-11-15T10:02:00Z", chars: 5 });
  fetchMock.mockResolvedValue(respond(204, null));
  await deleteDocument("d1");
  expect(lastCall().init.method).toBe("DELETE");
});

test("writeText: 409 → ApiError document_conflict", async () => {
  fetchMock.mockResolvedValue(
    respond(409, {
      error: { message: "изменён", type: "invalid_request_error", code: "document_conflict" },
    }),
  );
  const error: unknown = await writeText("d1", { revision: 0, text: "" }).catch((e: unknown) => e);
  expect(error instanceof ApiError && error.code).toBe("document_conflict");
});
