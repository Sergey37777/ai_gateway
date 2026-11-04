import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "../api/errors";
import type { Transcription, TranscriptionJob } from "../api/types";
import { job } from "./fixtures";
import { RecordScreen } from "./RecordScreen";

const RESULT: Transcription = {
  text: "Привет мир",
  language: "russian",
  duration: 2,
  segments: [{ id: 0, start: 0, end: 2, text: " Привет мир" }],
  words: [
    { word: " Привет", start: 0, end: 1 },
    { word: " мир", start: 1, end: 2 },
  ],
  raw: "{}",
};

type JobFn = (id: string) => Promise<TranscriptionJob>;

function deps(overrides: Record<string, unknown> = {}) {
  return {
    getTranscription: vi.fn<JobFn>(() => Promise.resolve(job())),
    getResult: vi.fn<(id: string) => Promise<Transcription>>(() => Promise.resolve(RESULT)),
    getAudio: vi.fn<(id: string) => Promise<Blob>>(() => Promise.resolve(new Blob(["opus"]))),
    cancelTranscription: vi.fn<JobFn>(() => Promise.resolve(job({ status: "cancelled" }))),
    retryTranscription: vi.fn<JobFn>(() => Promise.resolve(job({ status: "queued" }))),
    renameTranscription: vi.fn<(id: string, title: string) => Promise<TranscriptionJob>>(
      (_id, title) => Promise.resolve(job({ title })),
    ),
    deleteTranscription: vi.fn<(id: string) => Promise<void>>(() => Promise.resolve()),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal(
    "URL",
    Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(d: ReturnType<typeof deps>, localFile: File | null = null) {
  const onDeleted = vi.fn<() => void>();
  const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
  render(<RecordScreen id="job-1" localFile={localFile} onDeleted={onDeleted} deps={d} />);
  return { user, onDeleted };
}

test("готовая запись: текст, слова и плеер по аудио с сервера", async () => {
  const d = deps();
  setup(d);
  expect(await screen.findByText("Привет мир")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Совещание" })).toBeInTheDocument();
  expect(document.querySelectorAll(".word")).toHaveLength(2);
  expect(d.getAudio).toHaveBeenCalledWith("job-1");
  expect(document.querySelector("audio")).not.toBeNull();
});

test("свежая загрузка играет локальный файл (видео)", async () => {
  const d = deps();
  setup(d, new File(["v"], "clip.mp4", { type: "video/mp4" }));
  await screen.findByText("Привет мир");
  expect(d.getAudio).not.toHaveBeenCalled();
  expect(document.querySelector("video")).not.toBeNull();
});

test("идёт распознавание: ход, отмена, опрос до готовности", async () => {
  const d = deps({
    getTranscription: vi
      .fn<JobFn>()
      .mockResolvedValueOnce(job({ status: "running", progress: 0.42 }))
      .mockResolvedValueOnce(job({ status: "running", progress: 0.42 }))
      .mockResolvedValue(job()),
    // сервер останавливает выполняющуюся задачу асинхронно: в ответе она ещё running
    cancelTranscription: vi.fn<JobFn>(() =>
      Promise.resolve(job({ status: "running", progress: 0.42 })),
    ),
  });
  const { user } = setup(d);
  expect(await screen.findByText("Распознаётся — 42%")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Отмена" }));
  expect(d.cancelTranscription).toHaveBeenCalledWith("job-1");
  await vi.advanceTimersByTimeAsync(2000);
  expect(await screen.findByText("Привет мир")).toBeInTheDocument();
});

test("ошибка: текст и «Повторить»", async () => {
  const d = deps({
    getTranscription: vi.fn<JobFn>(() =>
      Promise.resolve(
        job({
          status: "failed",
          retryable: true,
          error: { code: "model_unavailable", message: "Модели не хватило памяти" },
        }),
      ),
    ),
  });
  const { user } = setup(d);
  expect(await screen.findByRole("alert")).toHaveTextContent("Модели не хватило памяти");
  await user.click(screen.getByRole("button", { name: "Повторить" }));
  expect(d.retryTranscription).toHaveBeenCalledWith("job-1");
});

test("ошибка без возможности повтора — кнопки нет", async () => {
  const d = deps({
    getTranscription: vi.fn<JobFn>(() =>
      Promise.resolve(
        job({ status: "failed", error: { code: "invalid_audio", message: "Не аудио" } }),
      ),
    ),
  });
  setup(d);
  expect(await screen.findByRole("alert")).toHaveTextContent("Не аудио");
  expect(screen.queryByRole("button", { name: "Повторить" })).toBeNull();
});

test("переименование: Enter сохраняет, Escape отменяет", async () => {
  const d = deps();
  const { user } = setup(d);
  await screen.findByText("Привет мир");
  await user.click(screen.getByRole("button", { name: "Переименовать" }));
  const input = screen.getByRole("textbox", { name: "Название" });
  await user.clear(input);
  await user.type(input, "Планёрка{Enter}");
  expect(d.renameTranscription).toHaveBeenCalledWith("job-1", "Планёрка");
  expect(await screen.findByRole("heading", { name: "Планёрка" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Переименовать" }));
  await user.type(screen.getByRole("textbox", { name: "Название" }), "x{Escape}");
  expect(d.renameTranscription).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("heading", { name: "Планёрка" })).toBeInTheDocument();
});

test("удаление с подтверждением", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  const d = deps();
  const { user, onDeleted } = setup(d);
  await screen.findByText("Привет мир");
  await user.click(screen.getByRole("button", { name: "Удалить" }));
  expect(confirm).toHaveBeenCalled();
  expect(d.deleteTranscription).toHaveBeenCalledWith("job-1");
  expect(onDeleted).toHaveBeenCalled();
  confirm.mockRestore();
});

test("запись не найдена", async () => {
  const d = deps({
    getTranscription: vi.fn<JobFn>(() =>
      Promise.reject(new ApiError("Распознавание не найдено", 404, "transcription_not_found")),
    ),
  });
  setup(d);
  expect(await screen.findByText("Такой записи нет — возможно, её удалили")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Вся история" })).toHaveAttribute("href", "#history");
});
