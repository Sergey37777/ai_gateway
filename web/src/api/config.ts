import { networkError, parseErrorResponse } from "./errors";
import { isRecord } from "./json";
import type { UiConfig } from "./types";

/** `GET /ui/config` — лимит загрузки, модели, языки. */
export async function fetchConfig(fetchFn: typeof fetch = fetch): Promise<UiConfig> {
  let response: Response;
  try {
    response = await fetchFn("/ui/config");
  } catch {
    throw networkError();
  }
  const body = await response.text();
  if (!response.ok) {
    throw parseErrorResponse(response.status, body, response.headers.get("Retry-After"));
  }
  const data: unknown = JSON.parse(body);
  if (!isUiConfig(data)) throw new Error("Некорректный ответ /ui/config");
  // шлюз до этапа 6 лимита документов не присылал
  return {
    ...data,
    max_document_mb: typeof data.max_document_mb === "number" ? data.max_document_mb : 5,
  };
}

function isUiConfig(value: unknown): value is UiConfig {
  return (
    isRecord(value) &&
    typeof value["max_upload_mb"] === "number" &&
    typeof value["auth_required"] === "boolean" &&
    typeof value["default_transcription"] === "string" &&
    Array.isArray(value["models"]) &&
    Array.isArray(value["languages"])
  );
}
