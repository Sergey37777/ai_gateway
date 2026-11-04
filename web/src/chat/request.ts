/** Тело запроса chat.completions из истории и настроек. */

import type {
  ChatCompletionContentPart,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type { ChatMessage } from "./state";

export type ReasoningEffort = "none" | "low" | "medium" | "high";

export interface ChatSettings {
  model: string;
  systemPrompt: string;
  temperature: number | null;
  maxTokens: number | null;
  /** `null` — не отправлять, решает модель. */
  reasoningEffort: ReasoningEffort | null;
}

function toParam(message: ChatMessage): ChatCompletionMessageParam | null {
  if (message.role === "user") {
    if (message.images.length === 0) return { role: "user", content: message.text };
    const parts: ChatCompletionContentPart[] = [
      { type: "text", text: message.text },
      ...message.images.map((image): ChatCompletionContentPart => ({
        type: "image_url",
        image_url: { url: image.dataUrl },
      })),
    ];
    return { role: "user", content: parts };
  }
  // рассуждения обратно не отправляются; ответы с ошибкой и пустые — тоже
  if (message.status === "error" || message.content === "") return null;
  return { role: "assistant", content: message.content };
}

export function buildRequest(
  history: ChatMessage[],
  settings: ChatSettings,
): ChatCompletionCreateParamsStreaming {
  const messages: ChatCompletionMessageParam[] = [];
  const system = settings.systemPrompt.trim();
  if (system !== "") messages.push({ role: "system", content: system });
  for (const message of history) {
    const param = toParam(message);
    if (param !== null) messages.push(param);
  }
  return {
    model: settings.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(settings.temperature !== null && { temperature: settings.temperature }),
    ...(settings.maxTokens !== null && { max_tokens: settings.maxTokens }),
    ...(settings.reasoningEffort !== null && { reasoning_effort: settings.reasoningEffort }),
  };
}
