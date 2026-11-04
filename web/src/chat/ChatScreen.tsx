import { useEffect, useRef, useState } from "react";
import { streamChat as defaultStreamChat } from "../api/chat";
import { isAbortError, userMessage } from "../api/errors";
import type { ScreenProps } from "../screen";
import { ChatSettings } from "./ChatSettings";
import { EMPTY_SETTINGS, parseMaxTokens, parseTemperature, type SettingsDraft } from "./settings";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { buildRequest, type ChatSettings as RequestSettings } from "./request";
import {
  chatReducer,
  historyBefore,
  initialChatState,
  type ChatAction,
  type ChatState,
} from "./state";

interface Deps {
  streamChat?: typeof defaultStreamChat;
}

interface Props extends ScreenProps {
  /** Подмена API в тестах. */
  deps?: Deps;
}

export function ChatScreen({ config, onDirtyChange, deps }: Props) {
  const streamChat = deps?.streamChat ?? defaultStreamChat;
  const models = config.models.filter((m) => m.kind === "chat");
  const [model, setModel] = useState(models[0]?.id ?? "");
  const [draft, setDraft] = useState<SettingsDraft>(EMPTY_SETTINGS);
  const [state, setState] = useState<ChatState>(initialChatState);
  // состояние меняется синхронно через ref: обработчики в одном тике видят актуальное значение
  const stateRef = useRef(state);
  const controllerRef = useRef<AbortController | null>(null);
  const busy = state.streamingId !== null;

  useEffect(() => {
    onDirtyChange(state.messages.length > 0);
  }, [state.messages.length, onDirtyChange]);

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
    return next;
  };

  const settings = (): RequestSettings => ({
    model,
    systemPrompt: draft.systemPrompt,
    temperature: parseTemperature(draft.temperature),
    maxTokens: parseMaxTokens(draft.maxTokens),
    reasoningEffort: draft.reasoningEffort === "" ? null : draft.reasoningEffort,
  });

  /** Начинает запрос для ответа, который ждёт его (`pending`). */
  const startPending = (next: ChatState) => {
    const id = next.pending;
    if (id === null) return;
    apply({ type: "started", id });
    const controller = new AbortController();
    controllerRef.current = controller;
    const body = buildRequest(historyBefore(next, id), settings());
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
        apply({ type: "finish", id });
      } catch (error) {
        // стоп уже отражён в состоянии действием stop
        if (isAbortError(error)) return;
        apply({ type: "fail", id, message: userMessage(error) });
      }
    })();
  };

  const run = (action: ChatAction) => {
    startPending(apply(action));
  };

  const stop = () => {
    const id = stateRef.current.streamingId;
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (id !== null) apply({ type: "stop", id });
  };

  const clear = () => {
    if (
      stateRef.current.messages.length > 0 &&
      !window.confirm("Очистить диалог? Истории нет — он пропадёт.")
    ) {
      return;
    }
    controllerRef.current?.abort();
    controllerRef.current = null;
    apply({ type: "clear" });
  };

  if (models.length === 0) {
    return <p className="card muted">В models.yaml нет чат-моделей (backend: ollama).</p>;
  }

  return (
    <div className="chat">
      <div className="card stack chat-toolbar">
        <div className="row">
          <div className="field">
            <label htmlFor="chat-model">Модель</label>
            <select
              id="chat-model"
              value={model}
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
          <button
            type="button"
            className="button-secondary chat-new"
            onClick={clear}
            disabled={state.messages.length === 0}
          >
            Новый чат
          </button>
        </div>
        <ChatSettings value={draft} onChange={setDraft} />
      </div>

      {state.messages.length === 0 ? (
        <p className="muted chat-empty">
          Задайте вопрос модели {model}. Картинку можно вставить из буфера.
        </p>
      ) : (
        <MessageList
          messages={state.messages}
          busy={busy}
          onEdit={(id, text) => {
            run({ type: "edit", id, text });
          }}
          onRegenerate={() => {
            run({ type: "regenerate" });
          }}
        />
      )}

      <Composer
        disabled={false}
        streaming={busy}
        onSend={(text, images) => {
          run({ type: "send", text, images });
        }}
        onStop={stop}
      />
    </div>
  );
}
