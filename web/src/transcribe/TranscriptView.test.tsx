import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Transcription } from "../api/types";
import { TranscriptView } from "./TranscriptView";

const RESULT: Transcription = {
  text: "Привет. Мир вокруг.",
  language: "russian",
  duration: 3,
  segments: [
    { id: 0, start: 0, end: 1.5, text: " Привет." },
    { id: 1, start: 1.5, end: 3, text: " Мир вокруг." },
  ],
  words: [
    { word: " Привет.", start: 0, end: 1.5 },
    { word: " Мир", start: 1.5, end: 2.2 },
    { word: " вокруг.", start: 2.2, end: 3 },
  ],
  raw: "{}",
};

beforeEach(() => {
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }),
  );
  // jsdom не реализует воспроизведение: currentTime храним сами, play — заглушка
  const times = new WeakMap<HTMLMediaElement, number>();
  Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
    configurable: true,
    get(this: HTMLMediaElement) {
      return times.get(this) ?? 0;
    },
    set(this: HTMLMediaElement, value: number) {
      times.set(this, value);
    },
  });
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    writable: true,
    value: () => Promise.resolve(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function show(result: Transcription = RESULT, media: Blob | null = new Blob(["a"])) {
  const user = userEvent.setup();
  render(
    <TranscriptView
      result={result}
      title="Совещание"
      media={media}
      video={false}
      downloadName="meeting"
    />,
  );
  return { user, media: document.querySelector("audio") };
}

function player(element: HTMLMediaElement | null): HTMLMediaElement {
  if (element === null) throw new Error("нет плеера");
  return element;
}

test("заголовок, текст и перемотка по таймкоду", async () => {
  const { user, media } = show();
  expect(screen.getByRole("heading", { name: "Совещание" })).toBeInTheDocument();
  expect(screen.getByText("Привет. Мир вокруг.")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "[00:00:01]" }));
  expect(player(media).currentTime).toBe(1.5);
  for (const format of ["txt", "srt", "vtt", "json"]) {
    expect(screen.getByRole("button", { name: format })).toBeInTheDocument();
  }
});

test("клик по слову перематывает к его началу", async () => {
  const play = vi.spyOn(HTMLMediaElement.prototype, "play");
  const { user, media } = show();
  await user.click(screen.getByText("вокруг."));
  expect(player(media).currentTime).toBe(2.2);
  expect(play).toHaveBeenCalled();
});

test("клик мимо слова не перематывает", async () => {
  const { user, media } = show();
  player(media).currentTime = 0.7;
  const list = document.querySelector(".segments");
  if (list === null) throw new Error("нет списка сегментов");
  await user.click(list);
  expect(player(media).currentTime).toBe(0.7);
});

test("текущее слово подсвечено", () => {
  const { media } = show();
  player(media).currentTime = 2.5;
  fireEvent.timeUpdate(player(media));
  expect(screen.getByText("вокруг.")).toHaveClass("word-active");
  expect(screen.getByText("Привет.")).not.toHaveClass("word-active");
});

test("без слов текст сегмента строкой", () => {
  show({ ...RESULT, words: [] });
  expect(screen.getByText("Привет.")).toBeInTheDocument();
  expect(document.querySelector(".word")).toBeNull();
});

test("плеер не открылся — слова и таймкоды не кликабельны", async () => {
  const { user, media } = show();
  fireEvent.error(player(media));
  expect(screen.queryByRole("button", { name: "[00:00:01]" })).toBeNull();
  await user.click(screen.getByText("вокруг."));
  expect(screen.getByText("Браузер не может воспроизвести этот файл")).toBeInTheDocument();
});

test("без аудио — плеера нет, перемотки нет", () => {
  show(RESULT, null);
  expect(document.querySelector("audio")).toBeNull();
  expect(screen.getByText("Аудио для этой записи не сохранилось")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "[00:00:01]" })).toBeNull();
});

test("видео — плеер video", () => {
  render(
    <TranscriptView
      result={RESULT}
      title="Ролик"
      media={new File(["v"], "a.mp4", { type: "video/mp4" })}
      video
      downloadName="a"
    />,
  );
  expect(document.querySelector("video")).not.toBeNull();
});

test("пустой результат", () => {
  show({ ...RESULT, text: "", segments: [], words: [] });
  expect(screen.getByText("Речь не распознана")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "srt" })).toBeInTheDocument();
});
