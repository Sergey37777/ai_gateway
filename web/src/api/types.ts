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

/** Статус распознавания в истории (`/api/transcriptions`). */
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/** Объект распознавания `/api/transcriptions/{id}`. */
export interface TranscriptionJob {
  id: string;
  status: JobStatus;
  source: "ui" | "api";
  title: string;
  filename: string;
  model: string;
  language: string | null;
  duration: number | null;
  progress: number | null;
  queue_position: number | null;
  error: { code: string; message: string } | null;
  has_audio: boolean;
  /** «Повторить» доступно (загрузка ещё хранится). */
  retryable: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  /** Фрагмент текста с «совпадениями» — только в результатах поиска. */
  snippet?: string;
}

export interface TranscriptionPage {
  data: TranscriptionJob[];
  next: string | null;
}

/** Настройки диалога в API (`/api/conversations`). */
export interface ApiChatSettings {
  model: string;
  system_prompt: string;
  temperature: number | null;
  max_tokens: number | null;
  reasoning_effort: "none" | "low" | "medium" | "high" | null;
}

export interface ApiUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface ApiUserMessage {
  role: "user";
  text: string;
  images: { name: string; data_url: string }[];
}

export interface ApiAssistantMessage {
  role: "assistant";
  text: string;
  reasoning: string;
  status: "done" | "stopped" | "error";
  error: string | null;
  usage: ApiUsage | null;
  model: string | null;
}

export type ApiMessage = ApiUserMessage | ApiAssistantMessage;

/** Диалог без сообщений (ответ `PATCH`). */
export interface ConversationMeta {
  id: string;
  title: string;
  settings: ApiChatSettings;
  revision: number;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface Conversation extends ConversationMeta {
  messages: ApiMessage[];
}

/** Элемент списка диалогов; `snippet` — только в результатах поиска (`null` — совпало название). */
export interface ConversationItem {
  id: string;
  title: string;
  model: string;
  message_count: number;
  created_at: string;
  updated_at: string;
  snippet?: string;
}

export interface ConversationPage {
  data: ConversationItem[];
  next: string | null;
}

/** Ответ `PUT /api/conversations/{id}/messages`. */
export interface TailResult {
  revision: number;
  updated_at: string;
  message_count: number;
}
