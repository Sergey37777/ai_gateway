/** Типы ответов шлюза, которые использует UI. */

export type ModelKind = "transcription" | "chat";

export interface UiModel {
  id: string;
  kind: ModelKind;
}

export interface UiLanguage {
  code: string;
  name: string;
}

/** Ответ `GET /ui/config`. */
export interface UiConfig {
  max_upload_mb: number;
  auth_required: boolean;
  default_transcription: string;
  models: UiModel[];
  languages: UiLanguage[];
}

/** Сегмент `verbose_json` (прочие поля ответа UI не нужны). */
export interface Segment {
  id: number;
  start: number;
  end: number;
  text: string;
}

/** Слово `verbose_json` с таймкодами (секунды); пробел перед словом — как отдал Whisper. */
export interface Word {
  word: string;
  start: number;
  end: number;
}

/** Результат распознавания; `raw` — тело ответа как есть (для скачивания json). */
export interface Transcription {
  text: string;
  language: string;
  duration: number;
  segments: Segment[];
  /** Пустой массив, если сервер слов не вернул. */
  words: Word[];
  raw: string;
}
