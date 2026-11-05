import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import type { CreateOptions } from "../api/transcriptions";
import type { TranscriptionJob, UiConfig } from "../api/types";
import type { UploadHooks } from "../api/xhr";
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

const JOB: TranscriptionJob = {
  id: "job-1",
  status: "queued",
  source: "ui",
  title: "a.wav",
  filename: "a.wav",
  model: "whisper-base",
  language: null,
  duration: null,
  progress: 0,
  queue_position: 1,
  error: null,
  has_audio: false,
  retryable: false,
  created_at: "2026-11-04T18:00:00Z",
  started_at: null,
  finished_at: null,
};

type CreateFn = (
  file: File,
  options: CreateOptions,
  hooks?: UploadHooks,
) => Promise<TranscriptionJob>;
type ExtractFn = (file: File, hooks?: ExtractHooks) => Promise<File>;

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(deps: { createTranscription?: CreateFn; extractAudio?: ExtractFn }) {
  const onDirtyChange = vi.fn<(dirty: boolean) => void>();
  const onCreated = vi.fn<(job: TranscriptionJob, file: File) => void>();
  const user = userEvent.setup();
  render(
    <TranscribeScreen
      config={CONFIG}
      onDirtyChange={onDirtyChange}
      onCreated={onCreated}
      deps={deps}
    />,
  );
  return { user, onDirtyChange, onCreated };
}

test("файл больше лимита — сообщение без запроса", async () => {
  const createTranscription = vi.fn<CreateFn>();
  const { user } = setup({ createTranscription });
  await user.upload(
    screen.getByLabelText("Аудио или видео файл"),
    new File([new Uint8Array(3 * MB)], "long.wav", { type: "audio/wav" }),
  );
  expect(
    screen.getByText("Файл 3.0 МБ больше лимита 1 МБ (AIGW_MAX_UPLOAD_MB)"),
  ).toBeInTheDocument();
  expect(createTranscription).not.toHaveBeenCalled();
});

test("загрузка создаёт фоновую задачу и передаёт её наверх", async () => {
  const createTranscription = vi.fn<CreateFn>(() => Promise.resolve(JOB));
  const { user, onCreated, onDirtyChange } = setup({ createTranscription });
  const file = new File(["0123456789"], "hello.wav", { type: "audio/wav" });
  await user.upload(screen.getByLabelText("Аудио или видео файл"), file);
  await waitFor(() => {
    expect(onCreated).toHaveBeenCalledWith(JOB, file);
  });
  expect(createTranscription).toHaveBeenCalledWith(
    file,
    { model: "whisper-base", language: null, title: null },
    expect.objectContaining({ signal: expect.any(AbortSignal) as unknown }),
  );
  // после создания задачи работа на сервере: закрыть вкладку уже можно
  expect(onDirtyChange).toHaveBeenCalledWith(true);
  expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  expect(screen.getByLabelText("Аудио или видео файл")).toBeEnabled();
});

test("выбранные модель и язык уходят в запрос", async () => {
  const createTranscription = vi.fn<CreateFn>(() => Promise.resolve(JOB));
  const { user, onCreated } = setup({ createTranscription });
  await user.selectOptions(screen.getByLabelText("Модель"), "whisper-tiny");
  await user.selectOptions(screen.getByLabelText("Язык"), "ru");
  await user.upload(
    screen.getByLabelText("Аудио или видео файл"),
    new File(["x"], "a.wav", { type: "audio/wav" }),
  );
  await waitFor(() => {
    expect(onCreated).toHaveBeenCalled();
  });
  expect(createTranscription.mock.calls[0]?.[1]).toEqual({
    model: "whisper-tiny",
    language: "ru",
    title: null,
  });
});

test("видео больше лимита — сначала извлечение аудио", async () => {
  const audio = new File(["a"], "movie.mka", { type: "audio/x-matroska" });
  const extractAudio = vi.fn<ExtractFn>(() => Promise.resolve(audio));
  const createTranscription = vi.fn<CreateFn>(() => Promise.resolve(JOB));
  const { user, onCreated } = setup({ createTranscription, extractAudio });
  const video = new File([new Uint8Array(3 * MB)], "movie.mp4", { type: "video/mp4" });
  await user.upload(screen.getByLabelText("Аудио или видео файл"), video);
  await waitFor(() => {
    expect(onCreated).toHaveBeenCalled();
  });
  expect(extractAudio.mock.calls[0]?.[0]).toBe(video);
  expect(createTranscription.mock.calls[0]?.[0]).toBe(audio);
  // название записи — по исходному видео, а не по извлечённой дорожке
  expect(createTranscription.mock.calls[0]?.[1].title).toBe("movie.mp4");
  // наверх уходит исходное видео — для плеера с картинкой
  expect(onCreated.mock.calls[0]?.[1]).toBe(video);
});

test("ошибка сервера показывается", async () => {
  const createTranscription = vi.fn<CreateFn>(() => Promise.reject(new Error("Модель недоступна")));
  const { user } = setup({ createTranscription });
  await user.upload(
    screen.getByLabelText("Аудио или видео файл"),
    new File(["x"], "a.wav", { type: "audio/wav" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Модель недоступна");
});

test("отмена во время загрузки", async () => {
  let signal: AbortSignal | undefined;
  const createTranscription = vi.fn<CreateFn>((_file, _options, hooks) => {
    signal = hooks?.signal;
    return new Promise((_resolve, reject) => {
      hooks?.signal?.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  });
  const { user, onCreated } = setup({ createTranscription });
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
  expect(onCreated).not.toHaveBeenCalled();
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
  const createTranscription = vi.fn<CreateFn>(() => new Promise<TranscriptionJob>(() => undefined));
  const { user } = setup({ createTranscription });
  await user.click(screen.getByRole("button", { name: "Записать с микрофона" }));
  const stop = await screen.findByRole("button", { name: /Остановить/ });
  await user.upload(
    screen.getByLabelText("Аудио или видео файл"),
    new File(["x"], "a.wav", { type: "audio/wav" }),
  );
  expect(createTranscription).toHaveBeenCalledTimes(1);
  await user.click(stop);
  expect(createTranscription).toHaveBeenCalledTimes(1);
  expect(
    screen.getByText("Дождитесь окончания текущей загрузки или отмените её"),
  ).toBeInTheDocument();
});
