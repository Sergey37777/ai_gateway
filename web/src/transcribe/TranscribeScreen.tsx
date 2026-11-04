import { useEffect, useReducer, useRef, useState } from "react";
import { userMessage, isAbortError } from "../api/errors";
import { createTranscription as defaultCreate } from "../api/transcriptions";
import type { TranscriptionJob } from "../api/types";
import { ErrorBanner } from "../components/ErrorBanner";
import type { ScreenProps } from "../screen";
import { extractAudio as defaultExtractAudio } from "./extractAudio";
import { FilePicker } from "./FilePicker";
import { MicRecorder } from "./MicRecorder";
import { extractedTooLarge, planUpload } from "./plan";
import { Progress } from "./Progress";
import { initialTranscribeState, isBusy, progressValue, transcribeReducer } from "./state";

interface Deps {
  createTranscription?: typeof defaultCreate;
  extractAudio?: typeof defaultExtractAudio;
}

interface Props extends ScreenProps {
  /** Сервер принял файл: задача создана; `file` — исходный (для плеера с видеорядом). */
  onCreated: (job: TranscriptionJob, file: File) => void;
  /** Подмена API в тестах. */
  deps?: Deps;
}

/** Приём файлов: модель, язык, зона загрузки, микрофон; распознаёт фоновая очередь. */
export function TranscribeScreen({ config, onDirtyChange, onCreated, deps }: Props) {
  const createTranscription = deps?.createTranscription ?? defaultCreate;
  const extractAudio = deps?.extractAudio ?? defaultExtractAudio;
  const models = config.models.filter((m) => m.kind === "transcription");
  const [model, setModel] = useState(config.default_transcription);
  const [language, setLanguage] = useState("");
  const [rejection, setRejection] = useState<string | null>(null);
  const [state, dispatch] = useReducer(transcribeReducer, initialTranscribeState);
  const nextOpId = useRef(1);
  const controllerRef = useRef<AbortController | null>(null);
  const busy = isBusy(state.phase);

  // после создания задачи работа на сервере — уйти со страницы можно
  useEffect(() => {
    onDirtyChange(busy);
  }, [busy, onDirtyChange]);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  const run = async (file: File) => {
    // запись с микрофона может закончиться, пока идёт операция с другим файлом
    if (controllerRef.current !== null) {
      setRejection("Дождитесь окончания текущей загрузки или отмените её");
      return;
    }
    const plan = planUpload(file, config.max_upload_mb);
    if (plan.kind === "too_large") {
      setRejection(plan.message);
      return;
    }
    setRejection(null);
    const opId = nextOpId.current++;
    const controller = new AbortController();
    controllerRef.current = controller;
    const { signal } = controller;
    dispatch({ type: "start", opId, source: file, extract: plan.kind === "extract" });
    try {
      let upload = file;
      if (plan.kind === "extract") {
        upload = await extractAudio(file, {
          signal,
          onProgress: (progress) => {
            dispatch({ type: "extractProgress", opId, progress });
          },
        });
        const tooLarge = extractedTooLarge(upload.size, config.max_upload_mb);
        if (tooLarge !== null) throw new Error(tooLarge);
        dispatch({ type: "extracted", opId });
      }
      const job = await createTranscription(
        upload,
        { model, language: language === "" ? null : language, title: null },
        {
          signal,
          onUploadProgress: (progress) => {
            dispatch({ type: "uploadProgress", opId, progress });
          },
        },
      );
      dispatch({ type: "created", opId });
      onCreated(job, file);
    } catch (error) {
      if (isAbortError(error)) return;
      dispatch({ type: "fail", opId, message: userMessage(error) });
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  };

  const onFile = (file: File) => {
    void run(file);
  };

  const cancel = () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    dispatch({ type: "cancel" });
  };

  return (
    <div className="stack transcribe">
      <div className="toolbar">
        <div className="row">
          <div className="field">
            <label htmlFor="transcribe-model">Модель</label>
            <select
              id="transcribe-model"
              value={model}
              disabled={busy}
              onChange={(event) => {
                setModel(event.target.value);
              }}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="transcribe-language">Язык</label>
            <select
              id="transcribe-language"
              value={language}
              disabled={busy}
              onChange={(event) => {
                setLanguage(event.target.value);
              }}
            >
              <option value="">Автоопределение</option>
              {config.languages.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.code} — {l.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      <FilePicker
        disabled={busy}
        onFile={onFile}
        progress={progressValue(state.phase)}
        status={busy ? <Progress phase={state.phase} onCancel={cancel} /> : undefined}
        footnote={
          <>
            Файлы до {config.max_upload_mb} МБ. Из видео больше лимита браузер сам извлечёт
            аудиодорожку и отправит только её.
          </>
        }
      >
        <MicRecorder disabled={busy} onRecorded={onFile} />
      </FilePicker>
      {rejection !== null && <ErrorBanner message={rejection} />}
      {state.phase.name === "error" && <ErrorBanner message={state.phase.message} />}
    </div>
  );
}
