import { gzipSync, strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { extractArchive, isArchiveName, MAX_ARCHIVE_DOCUMENTS, titlesFromPaths } from "./archive";

const OPTIONS = {
  accept: (path: string) => /\.(md|markdown|txt)$/i.test(path),
  maxEntryBytes: 1024,
};

const decode = (data: Uint8Array) => new TextDecoder().decode(data);

function summary(data: Uint8Array) {
  const result = extractArchive(data, OPTIONS);
  if (!result.ok) return result;
  return {
    entries: result.entries.map((e) => [e.path, decode(e.data)]),
    oversized: result.oversized,
    skipped: result.skipped,
  };
}

/** Заголовок tar (POSIX ustar) и данные, выровненные по 512 байт. */
function tarEntry(
  name: string,
  content: string | Uint8Array,
  options: { type?: string; prefix?: string; gnu?: boolean } = {},
): Uint8Array {
  const body = typeof content === "string" ? strToU8(content) : content;
  const header = new Uint8Array(512);
  header.set(strToU8(name).subarray(0, 100), 0);
  header.set(strToU8("0000644\0"), 100);
  header.set(strToU8(`${body.length.toString(8).padStart(11, "0")}\0`), 124);
  header[156] = (options.type ?? "0").charCodeAt(0);
  header.set(strToU8(options.gnu === true ? "ustar  \0" : "ustar\u000000"), 257);
  if (options.prefix !== undefined) header.set(strToU8(options.prefix), 345);
  const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
  padded.set(body);
  const result = new Uint8Array(512 + padded.length);
  result.set(header);
  result.set(padded, 512);
  return result;
}

function tar(...entries: Uint8Array[]): Uint8Array {
  const total = entries.reduce((sum, e) => sum + e.length, 0) + 1024;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const entry of entries) {
    result.set(entry, offset);
    offset += entry.length;
  }
  return result;
}

function pax(path: string): Uint8Array {
  const record = (length: number) => `${String(length)} path=${path}\n`;
  let length = strToU8(record(0)).length;
  while (strToU8(record(length)).length !== length) length = strToU8(record(length)).length;
  return tarEntry("PaxHeaders/x", record(length), { type: "x" });
}

test("isArchiveName", () => {
  expect(["a.zip", "b.TAR", "c.tgz", "d.tar.gz"].every(isArchiveName)).toBe(true);
  expect(["a.md", "a.gz", "zip"].some(isArchiveName)).toBe(false);
});

describe("zip", () => {
  test("текстовые файлы — записи; остальное — пропущено; мусор — молча", () => {
    const zip = zipSync({
      "docs/readme.md": strToU8("# Привет"),
      "docs/guide/install.txt": strToU8("шаги"),
      "docs/logo.png": new Uint8Array([1, 2, 3]),
      "docs/.hidden.md": strToU8("скрыто"),
      "__MACOSX/docs/._readme.md": strToU8("мусор"),
      "docs/empty/": new Uint8Array(),
    });
    expect(summary(zip)).toEqual({
      entries: [
        ["docs/readme.md", "# Привет"],
        ["docs/guide/install.txt", "шаги"],
      ],
      oversized: [],
      skipped: ["docs/logo.png"],
    });
  });

  test("файл больше лимита — не распаковывается, попадает в oversized", () => {
    const zip = zipSync({ "big.md": new Uint8Array(2048).fill(0x61), "ok.md": strToU8("x") });
    expect(summary(zip)).toEqual({
      entries: [["ok.md", "x"]],
      oversized: ["big.md"],
      skipped: [],
    });
  });

  test("имя в CP866 без флага UTF-8 (Проводник Windows)", () => {
    const zip = zipSync({ "XXXXXX.md": strToU8("текст") }, { level: 0 });
    const placeholder = strToU8("XXXXXX");
    // «Привет» в CP866
    const cp866 = [0x8f, 0xe0, 0xa8, 0xa2, 0xa5, 0xe2];
    for (let i = 0; i + placeholder.length <= zip.length; i += 1) {
      if (placeholder.every((byte, k) => zip[i + k] === byte)) zip.set(cp866, i);
    }
    expect(summary(zip)).toMatchObject({ entries: [["Привет.md", "текст"]] });
  });

  test("имя в UTF-8 с флагом", () => {
    const zip = zipSync({ "Заметки/Итоги.md": strToU8("ok") });
    expect(summary(zip)).toMatchObject({ entries: [["Заметки/Итоги.md", "ok"]] });
  });

  test("повреждённый архив — понятная ошибка", () => {
    const zip = zipSync({ "a.md": strToU8("x".repeat(100)) });
    expect(extractArchive(zip.subarray(0, 40), OPTIONS)).toEqual({
      ok: false,
      message: "Не удалось распаковать архив — он повреждён или зашифрован",
    });
  });

  test(`больше ${String(MAX_ARCHIVE_DOCUMENTS)} документов — отказ`, () => {
    const files = Object.fromEntries(
      Array.from({ length: MAX_ARCHIVE_DOCUMENTS + 1 }, (_, i) => [
        `${String(i)}.md`,
        strToU8("x"),
      ]),
    );
    const result = extractArchive(zipSync(files), OPTIONS);
    expect(result.ok).toBe(false);
  });
});

describe("tar", () => {
  test("ustar: prefix, каталоги пропускаются, конец по нулевым блокам", () => {
    const data = tar(
      tarEntry("docs/", "", { type: "5" }),
      tarEntry("readme.md", "# Тар", { prefix: "docs" }),
      tarEntry("docs/image.jpg", "jpg"),
    );
    expect(summary(data)).toEqual({
      entries: [["docs/readme.md", "# Тар"]],
      oversized: [],
      skipped: ["docs/image.jpg"],
    });
  });

  test("pax path (длинные и кириллические имена) и GNU longname", () => {
    const longName = `${"очень-длинная-папка/".repeat(6)}файл.md`;
    const data = tar(
      pax(longName),
      tarEntry("ignored.md", "из pax"),
      tarEntry("././@LongLink", "gnu/длинное.txt", { type: "L", gnu: true }),
      tarEntry("cut.txt", "из gnu", { gnu: true }),
    );
    expect(summary(data)).toMatchObject({
      entries: [
        [longName, "из pax"],
        ["gnu/длинное.txt", "из gnu"],
      ],
    });
  });

  test("tar.gz", () => {
    const data = gzipSync(tar(tarEntry("a.md", "сжатый")));
    expect(summary(data)).toMatchObject({ entries: [["a.md", "сжатый"]] });
  });

  test("обрезанный tar и .gz без tar", () => {
    const data = tar(tarEntry("a.md", "x".repeat(600)));
    expect(extractArchive(data.subarray(0, 700), OPTIONS)).toEqual({
      ok: false,
      message: "Архив повреждён или обрезан",
    });
    expect(extractArchive(gzipSync(strToU8("просто текст")), OPTIONS)).toEqual({
      ok: false,
      message: "Внутри .gz нет tar-архива",
    });
  });
});

test("неизвестный формат", () => {
  expect(extractArchive(strToU8("Rar!"), OPTIONS)).toEqual({
    ok: false,
    message: "Неизвестный формат архива (нужен .zip, .tar или .tar.gz)",
  });
});

test("titlesFromPaths: общий корень срезается, расширение убирается", () => {
  expect(titlesFromPaths(["docs/readme.md", "docs/guide/install.txt"])).toEqual([
    "readme",
    "guide/install",
  ]);
  expect(titlesFromPaths(["a.md", "b/c.md"])).toEqual(["a", "b/c"]);
  expect(titlesFromPaths(["only/one.md"])).toEqual(["one"]);
  expect(titlesFromPaths(["v1.2/.md"])).toEqual(["Без названия"]);
  expect(titlesFromPaths([`${"x".repeat(300)}.md`], 10)).toEqual([`…${"x".repeat(9)}`]);
});
