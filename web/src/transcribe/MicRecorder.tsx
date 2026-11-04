import { useEffect, useRef, useState } from "react";
import { formatClock } from "./exports";
import { pickRecorderType } from "./media";

interface Props {
  disabled: boolean;
  onRecorded: (file: File) => void;
}

function micAvailable(): boolean {
  return (
    window.isSecureContext &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof window.MediaRecorder === "function"
  );
}

function p(n: number): string {
  return String(n).padStart(2, "0");
}

function recordingName(ext: string, now: Date): string {
  return `recording-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.${ext}`;
}

/** «Записал → отправил»: запись с микрофона в файл, который уходит на распознавание. */
export function MicRecorder({ disabled, onRecorded }: Props) {
  const [recording, setRecording] = useState<{ startedAt: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const available = micAvailable();

  useEffect(() => {
    if (recording === null) return undefined;
    const timer = window.setInterval(() => {
      setElapsed((Date.now() - recording.startedAt) / 1000);
    }, 500);
    return () => {
      window.clearInterval(timer);
    };
  }, [recording]);

  // уход со страницы / размонтирование во время записи — остановить микрофон
  useEffect(
    () => () => {
      const recorder = recorderRef.current;
      if (recorder !== null && recorder.state !== "inactive") {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.stop();
        for (const track of recorder.stream.getTracks()) track.stop();
      }
    },
    [],
  );

  const start = async () => {
    setError(null);
    const type = pickRecorderType((t) => MediaRecorder.isTypeSupported(t));
    if (type === null) {
      setError("Браузер не поддерживает запись звука");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Нет доступа к микрофону");
      return;
    }
    const recorder = new MediaRecorder(stream, { mimeType: type.mimeType });
    const chunks: Blob[] = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener("stop", () => {
      // гасим индикатор микрофона в браузере
      for (const track of stream.getTracks()) track.stop();
      recorderRef.current = null;
      setRecording(null);
      const mime = type.mimeType.split(";")[0] ?? type.mimeType;
      onRecorded(new File(chunks, recordingName(type.ext, new Date()), { type: mime }));
    });
    recorderRef.current = recorder;
    recorder.start();
    setElapsed(0);
    setRecording({ startedAt: Date.now() });
  };

  if (!available) {
    return (
      <div className="mic">
        <button type="button" className="button-secondary" disabled>
          Записать с микрофона
        </button>
        <p className="muted mic-hint">
          Микрофон работает только на localhost или по https. В Chrome на другом устройстве:
          chrome://flags/#unsafely-treat-insecure-origin-as-secure → {window.location.origin}
        </p>
      </div>
    );
  }

  return (
    <div className="mic">
      {recording === null ? (
        <button
          type="button"
          className="button-secondary"
          disabled={disabled}
          onClick={() => {
            void start();
          }}
        >
          Записать с микрофона
        </button>
      ) : (
        <button
          type="button"
          className="button-danger"
          onClick={() => {
            recorderRef.current?.stop();
          }}
        >
          <span className="rec-dot" aria-hidden="true" /> Остановить · {formatClock(elapsed)}
        </button>
      )}
      {error !== null && <p className="mic-error">{error}</p>}
    </div>
  );
}
