import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Transcription, UiConfig } from "../api/types";
import type { TranscribeHooks, TranscribeOptions } from "../api/transcribe";
import type { ExtractHooks } from "./extractAudio";
import { TranscribeScreen } from "./TranscribeScreen";

const MB = 1024 * 1024;

const CONFIG: UiConfig = {
  max_upload_mb: 1,
  auth_required: false,
  default_transcription: "whisper-base",
  models: [
    { id: "whisper-tiny", kind: "transcription" },
    { id: "whisper-base", kind: "transcription" },
    { id: "qwen3-0.6b", kind: "chat" },
  ],
  languages: [
    { code: "en", name: "english" },
    { code: "ru", name: "russian" },
  ],
};

const RESULT: Transcription = {
  text: "Привет. Мир.",
  language: "russian",
  duration: 3,
  segments: [
    { id: 0, start: 0, end: 1.5, text: " Привет." },
    { id: 1, start: 1.5, end: 3, text: " Мир." },
  ],
  words: [
    { word: " Привет.", start: 0, end: 1.5 },
    { word: " Мир", start: 1.5, end: 2.2 },
    { word: " вокруг.", start: 2.2, end: 3 },
  ],
  raw: "{}",
};

type TranscribeFn = (
  file: File,
  options: TranscribeOptions,
  hooks?: TranscribeHooks,
) => Promise<Transcription>;
type ExtractFn = (file: File, hooks?: ExtractHooks) => Promise<File>;

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
    value: () => Promise.resolve(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(deps: { transcribe?: TranscribeFn; extractAudio?: ExtractFn }) {
  const onDirtyChange = vi.fn<(dirty: boolean) => void>();
  const user = userEvent.setup();
  render(<TranscribeScreen config={CONFIG} onDirtyChange={onDirtyChange} deps={deps} />);
  return { user, onDirtyChange };
}

test("файл больше лимита — сообщение без запроса", async () => {
  const transcribe = vi.fn<TranscribeFn>();
  const { user } = setup({ transcribe });
  await user.upload(
    screen.getByLabelText("Аудио или видео файл"),
    new File([new Uint8Array(3 * MB)], "long.wav", { type: "audio/wav" }),
  );
  expect(
    screen.getByText("Файл 3.0 МБ больше лимита 1 МБ (AIGW_MAX_UPLOAD_MB)"),
  ).toBeInTheDocument();
  expect(transcribe).not.toHaveBeenCalled();
});

test("успешное распознавание: сегменты и перемотка по таймкоду", async () => {
  const transcribe = vi.fn<TranscribeFn>(() => Promise.resolve(RESULT));
  const { user, onDirtyChange } = setup({ transcribe });
  const file = new File(["0123456789"], "hello.wav", { type: "audio/wav" });
  await user.upload(screen.getByLabelText("Аудио или видео файл"), file);
  expect(await screen.findByText("Привет.")).toBeInTheDocument();
  expect(transcribe).toHaveBeenCalledWith(
    file,
    { model: "whisper-base", language: null },
    expect.objectContaining({ signal: expect.any(AbortSignal) as unknown }),
  );
  await user.click(screen.getByRole("button", { name: "[00:00:01]" }));
  const media = document.querySelector("audio");
  expect(media?.currentTime).toBe(1.5);
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  for (const format of ["txt", "srt", "vtt", "json"]) {
    expect(screen.getByRole("button", { name: format })).toBeInTheDocument();
  }
});

async function showResult(result: Transcription) {
  const transcribe = vi.fn<TranscribeFn>(() => Promise.resolve(result));
  const { user } = setup({ transcribe });
  await user.upload(
    screen.getByLabelText("Аудио или видео файл"),
    new File(["x"], "a.wav", { type: "audio/wav" }),
  );
  await screen.findByRole("button", { name: "Распознать другой файл" });
  const media = document.querySelector("audio");
  if (media === null) throw new Error("нет плеера");
  return { user, media };
}

test("клик по слову перематывает к его началу", async () => {
  const play = vi.spyOn(HTMLMediaElement.prototype, "play");
  const { user, media } = await showResult(RESULT);
  await user.click(screen.getByText("вокруг."));
  expect(media.currentTime).toBe(2.2);
  expect(play).toHaveBeenCalled();
});

test("клик мимо слова не перематывает", async () => {
  const { user, media } = await showResult(RESULT);
  media.currentTime = 0.7;
  const list = document.querySelector(".segments");
  if (list === null) throw new Error("нет списка сегментов");
  await user.click(list);
  expect(media.currentTime).toBe(0.7);
});

test("текущее слово подсвечено", async () => {
  const { media } = await showResult(RESULT);
  media.currentTime = 2.5;
  fireEvent.timeUpdate(media);
  expect(screen.getByText("вокруг.")).toHaveClass("word-active");
  expect(screen.getByText("Привет.")).not.toHaveClass("word-active");
});

test("без слов текст сегмента строкой", async () => {
  await showResult({ ...RESULT, words: [] });
  expect(screen.getByText("Привет.")).toBeInTheDocument();
  expect(document.querySelector(".word")).toBeNull();
});

test("плеер не открылся — слова и таймкоды не кликабельны", async () => {
  const { user, media } = await showResult(RESULT);
  fireEvent.error(media);
  expect(screen.queryByRole("button", { name: "[00:00:01]" })).toBeNull();
  await user.click(screen.getByText("вокруг."));
  expect(screen.getByText("Браузер не может воспроизвести этот файл")).toBeInTheDocument();
});

test("выбранные модель и язык уходят в запрос", async () => {
  const transcribe = vi.fn<TranscribeFn>(() => Promise.resolve(RESULT));
  const { user } = setup({ transcribe });
  await user.selectOptions(screen.getByLabelText("Модель"), "whisper-tiny");
  await user.selectOptions(screen.getByLabelText("Язык"), "ru");
  await user.upload(
    screen.getByLabelText("Аудио или видео файл"),
    new File(["x"], "a.wav", { type: "audio/wav" }),
  );
  await screen.findByText("Привет.");
  expect(transcribe.mock.calls[0]?.[1]).toEqual({ model: "whisper-tiny", language: "ru" });
});

test("видео больше лимита — сначала извлечение аудио", async () => {
  const audio = new File(["a"], "movie.mka", { type: "audio/x-matroska" });
  const extractAudio = vi.fn<ExtractFn>(() => Promise.resolve(audio));
  const transcribe = vi.fn<TranscribeFn>(() => Promise.resolve(RESULT));
  const { user } = setup({ transcribe, extractAudio });
  const video = new File([new Uint8Array(3 * MB)], "movie.mp4", { type: "video/mp4" });
  await user.upload(screen.getByLabelText("Аудио или видео файл"), video);
  await screen.findByText("Привет.");
  expect(extractAudio.mock.calls[0]?.[0]).toBe(video);
  expect(transcribe.mock.calls[0]?.[0]).toBe(audio);
  // плеер — по исходному видео
  expect(document.querySelector("video")).not.toBeNull();
});

test("пустой результат", async () => {
  const transcribe = vi.fn<TranscribeFn>(() =>
    Promise.resolve({ ...RESULT, text: "", segments: [] }),
  );
  const { user } = setup({ transcribe });
  await user.upload(
    screen.getByLabelText("Аудио или видео файл"),
    new File(["x"], "silence.wav", { type: "audio/wav" }),
  );
  expect(await screen.findByText("Речь не распознана")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "srt" })).toBeInTheDocument();
});

test("ошибка сервера показывается", async () => {
  const transcribe = vi.fn<TranscribeFn>(() => Promise.reject(new Error("Модель недоступна")));
  const { user } = setup({ transcribe });
  await user.upload(
    screen.getByLabelText("Аудио или видео файл"),
    new File(["x"], "a.wav", { type: "audio/wav" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Модель недоступна");
});

test("отмена во время загрузки", async () => {
  let signal: AbortSignal | undefined;
  const transcribe = vi.fn<TranscribeFn>((_file, _options, hooks) => {
    signal = hooks?.signal;
    return new Promise((_resolve, reject) => {
      hooks?.signal?.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  });
  const { user } = setup({ transcribe });
  await user.upload(
    screen.getByLabelText("Аудио или видео файл"),
    new File(["x"], "a.wav", { type: "audio/wav" }),
  );
  await user.click(await screen.findByRole("button", { name: "Отмена" }));
  expect(signal?.aborted).toBe(true);
  await waitFor(() => {
    expect(screen.getByLabelText("Аудио или видео файл")).toBeEnabled();
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

/** Фейковый MediaRecorder: stop() сразу отдаёт один кусок и событие stop. */
class FakeMediaRecorder extends EventTarget {
  static isTypeSupported(type: string): boolean {
    return type === "audio/webm;codecs=opus";
  }
  state: "inactive" | "recording" = "inactive";
  readonly stream: MediaStream;
  constructor(stream: MediaStream) {
    super();
    this.stream = stream;
  }
  start(): void {
    this.state = "recording";
  }
  stop(): void {
    this.state = "inactive";
    const data = new Event("dataavailable");
    Object.assign(data, { data: new Blob(["voice"], { type: "audio/webm" }) });
    this.dispatchEvent(data);
    this.dispatchEvent(new Event("stop"));
  }
}

test("запись, законченная во время другой операции, не запускает вторую", async () => {
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  const stream = { getTracks: () => [{ stop: () => undefined }] };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: () => Promise.resolve(stream) },
  });
  const transcribe = vi.fn<TranscribeFn>(() => new Promise<Transcription>(() => undefined));
  const { user } = setup({ transcribe });
  await user.click(screen.getByRole("button", { name: "Записать с микрофона" }));
  const stop = await screen.findByRole("button", { name: /Остановить/ });
  await user.upload(
    screen.getByLabelText("Аудио или видео файл"),
    new File(["x"], "a.wav", { type: "audio/wav" }),
  );
  expect(transcribe).toHaveBeenCalledTimes(1);
  await user.click(stop);
  expect(transcribe).toHaveBeenCalledTimes(1);
  expect(
    screen.getByText("Дождитесь окончания текущего распознавания или отмените его"),
  ).toBeInTheDocument();
});
