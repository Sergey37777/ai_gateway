/**
 * Стрим ответа модели поверх reducer'а чата: общий для вкладки «Чат» и вопросов к документу.
 *
 * Состояние меняется синхронно через ref: обработчики в одном тике видят актуальное значение.
 * Каждое действие сообщается в `onApply` (сохранение диалога решает, что записать).
 */

import { useEffect, useRef, useState } from "react";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions";
import type { streamChat as defaultStreamChat } from "../api/chat";
import { isAbortError, userMessage } from "../api/errors";
import type { ChatSettings as RequestSettings } from "./request";
import {
  chatReducer,
  historyBefore,
  initialChatState,
  type ChatAction,
  type ChatState,
} from "./state";

export interface ChatSessionOptions {
  streamChat: typeof defaultStreamChat;
  /** Тело запроса из истории до ответа и настроек. */
  buildBody: (
    history: ChatState["messages"],
    settings: RequestSettings,
  ) => ChatCompletionCreateParamsStreaming;
  /** Настройки на момент запуска запроса. */
  settings: () => RequestSettings;
  /** После каждого действия, включая дельты стрима: что сохранять, решает вызывающий. */
  onApply: (next: ChatState, action: ChatAction) => void;
}

export function useChatSession(options: ChatSessionOptions) {
  const [state, setState] = useState<ChatState>(initialChatState);
  const stateRef = useRef(state);
  const controllerRef = useRef<AbortController | null>(null);
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  const apply = (action: ChatAction): ChatState => {
    const next = chatReducer(stateRef.current, action);
    stateRef.current = next;
    setState(next);
    optionsRef.current.onApply(next, action);
    return next;
  };

  /** Начинает запрос для ответа, который ждёт его (`pending`). */
  const startPending = (next: ChatState) => {
    const id = next.pending;
    if (id === null) return;
    apply({ type: "started", id });
    const controller = new AbortController();
    controllerRef.current = controller;
    const { streamChat, buildBody, settings: current } = optionsRef.current;
    const settings = current();
    const body = buildBody(historyBefore(next, id), settings);
    void (async () => {
      try {
        for await (const event of streamChat(body, controller.signal)) {
          switch (event.type) {
            case "content":
              apply({ type: "delta", id, content: event.text });
              break;
            case "reasoning":
              apply({ type: "delta", id, reasoning: event.text });
              break;
            case "usage":
              apply({ type: "usage", id, usage: event.usage });
              break;
          }
        }
        apply({ type: "finish", id, model: settings.model });
      } catch (error) {
        // стоп уже отражён в состоянии действием stop
        if (isAbortError(error)) return;
        apply({ type: "fail", id, message: userMessage(error), model: settings.model });
      }
    })();
  };

  const run = (action: ChatAction) => {
    startPending(apply(action));
  };

  /** Прервать стрим: обрезанный ответ остаётся со статусом `stopped`. */
  const stop = () => {
    const id = stateRef.current.streamingId;
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (id !== null) apply({ type: "stop", id, model: optionsRef.current.settings().model });
  };

  /** Прервать запрос без изменения состояния (диалог удаляется). */
  const abort = () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  };

  return { state, stateRef, apply, run, stop, abort, busy: state.streamingId !== null };
}
