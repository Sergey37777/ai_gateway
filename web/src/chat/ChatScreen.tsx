import { useEffect, useEffectEvent, useRef, useState } from "react";
import { streamChat as defaultStreamChat } from "../api/chat";
import * as conversationsApi from "../api/conversations";
import { ApiError, isAbortError, userMessage } from "../api/errors";
import type { ApiChatSettings, Conversation, ConversationItem } from "../api/types";
import { ErrorBanner } from "../components/ErrorBanner";
import { conversationHash } from "../route";
import type { ScreenProps } from "../screen";
import { ChatSettings } from "./ChatSettings";
import { Composer } from "./Composer";
import { ConversationHeader } from "./ConversationHeader";
import { ConversationList } from "./ConversationList";
import { MessageList } from "./MessageList";
import { fromApiMessages, fromApiSettings, toApiSettings } from "./persist";
import { buildRequest, type ChatSettings as RequestSettings } from "./request";
import { EMPTY_SETTINGS, parseMaxTokens, parseTemperature, type SettingsDraft } from "./settings";
import {
  chatReducer,
  historyBefore,
  initialChatState,
  type ChatAction,
  type ChatState,
} from "./state";
import { useConversationSaver } from "./useConversationSaver";

interface Deps {
  streamChat?: typeof defaultStreamChat;
  listConversations?: typeof conversationsApi.listConversations;
  getConversation?: typeof conversationsApi.getConversation;
  createConversation?: typeof conversationsApi.createConversation;
  replaceTail?: typeof conversationsApi.replaceTail;
  patchConversation?: typeof conversationsApi.patchConversation;
  deleteConversation?: typeof conversationsApi.deleteConversation;
}

interface Props extends ScreenProps {
  /** `#chat/<id>` — сохранённый диалог; `null` — новый. */
  conversationId: string | null;
  /** Вкладка показана: при показе список диалогов перечитывается. */
  visible: boolean;
  /** Подмена API в тестах. */
  deps?: Deps;
}

type Loading =
  | { kind: "ready" }
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; message: string };

const SETTINGS_KEY = "aigw.chat.settings";

/** Последние настройки — удобство одного браузера; хранилище может быть недоступно. */
function readStoredSettings(): { model: string; draft: SettingsDraft } | null {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    const parsed = conversationsApi.parseSettings(value);
    return parsed === null ? null : fromApiSettings(parsed);
  } catch {
    return null;
  }
}

function storeSettings(settings: ApiChatSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // приватный режим или запрет хранилища — настройки просто не запомнятся
  }
}

function hashFor(id: string | null): string {
  return id === null ? "#chat" : conversationHash(id);
}

export function ChatScreen({ config, onDirtyChange, conversationId, visible, deps }: Props) {
  const api = { ...conversationsApi, streamChat: defaultStreamChat, ...deps };
  const models = config.models.filter((m) => m.kind === "chat");
  const firstModel = models[0]?.id ?? "";
  const [initial] = useState(() => readStoredSettings());
  const [model, setModel] = useState(() =>
    initial !== null && models.some((m) => m.id === initial.model) ? initial.model : firstModel,
  );
  const [draft, setDraft] = useState<SettingsDraft>(initial?.draft ?? EMPTY_SETTINGS);
  const [state, setState] = useState<ChatState>(initialChatState);
  const [title, setTitle] = useState<string | null>(null);
  const [loading, setLoading] = useState<Loading>({ kind: "ready" });
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [items, setItems] = useState<ConversationItem[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // состояние меняется синхронно через ref: обработчики в одном тике видят актуальное значение
  const stateRef = useRef(state);
  const controllerRef = useRef<AbortController | null>(null);
  // какой диалог сейчас на экране (null — новый); смена пропа сравнивается с ним
  const openIdRef = useRef<string | null>(null);
  const settingsRef = useRef<RequestSettings>({
    model,
    systemPrompt: draft.systemPrompt,
    temperature: parseTemperature(draft.temperature),
    maxTokens: parseMaxTokens(draft.maxTokens),
    reasoningEffort: draft.reasoningEffort === "" ? null : draft.reasoningEffort,
  });

  const saver = useConversationSaver({
    api,
    onCreated: (conversation) => {
      openIdRef.current = conversation.id;
      setTitle(conversation.title);
      setItems((current) => [
        {
          id: conversation.id,
          title: conversation.title,
          model: conversation.settings.model,
          message_count: conversation.message_count,
          created_at: conversation.created_at,
          updated_at: conversation.updated_at,
        },
        ...(current ?? []).filter((item) => item.id !== conversation.id),
      ]);
      // адрес диалога без перезагрузки: экран уже показывает этот диалог
      window.location.replace(conversationHash(conversation.id));
    },
    onSaved: ({ id, updated_at: updatedAt }) => {
      setItems((current) => {
        if (current === null) return current;
        const found = current.find((item) => item.id === id);
        if (found === undefined) return current;
        return [{ ...found, updated_at: updatedAt }, ...current.filter((item) => item.id !== id)];
      });
    },
  });

  const busy = state.streamingId !== null;
  const conflict = saver.status.kind === "conflict";

  useEffect(() => {
    onDirtyChange(busy || saver.unsaved);
  }, [busy, saver.unsaved, onDirtyChange]);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  // вкладку снова показали — список диалогов перечитывается (изменения с других устройств)
  const [shownVisible, setShownVisible] = useState(visible);
  if (visible !== shownVisible) {
    setShownVisible(visible);
    if (visible) setReloadKey((key) => key + 1);
  }

  const apiSettings = (): ApiChatSettings => toApiSettings(settingsRef.current);

  const apply = (action: ChatAction): ChatState => {
    const next = chatReducer(stateRef.current, action);
    stateRef.current = next;
    setState(next);
    // дельты стрима не меняют сохраняемое (стримящийся ответ не пишется) — не пересчитываем план
    if (action.type !== "delta" && action.type !== "usage" && action.type !== "started") {
      saver.sync(next.messages, apiSettings());
    }
    return next;
  };

  const changeSettings = (nextModel: string, nextDraft: SettingsDraft) => {
    settingsRef.current = {
      model: nextModel,
      systemPrompt: nextDraft.systemPrompt,
      temperature: parseTemperature(nextDraft.temperature),
      maxTokens: parseMaxTokens(nextDraft.maxTokens),
      reasoningEffort: nextDraft.reasoningEffort === "" ? null : nextDraft.reasoningEffort,
    };
    setModel(nextModel);
    setDraft(nextDraft);
    storeSettings(apiSettings());
    saver.syncSettings(apiSettings());
  };

  /** Начинает запрос для ответа, который ждёт его (`pending`). */
  const startPending = (next: ChatState) => {
    const id = next.pending;
    if (id === null) return;
    apply({ type: "started", id });
    const controller = new AbortController();
    controllerRef.current = controller;
    const settings = settingsRef.current;
    const body = buildRequest(historyBefore(next, id), settings);
    void (async () => {
      try {
        for await (const event of api.streamChat(body, controller.signal)) {
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

  const stop = () => {
    const id = stateRef.current.streamingId;
    controllerRef.current?.abort();
    controllerRef.current = null;
    if (id !== null) apply({ type: "stop", id, model: settingsRef.current.model });
  };

  /** Показать диалог: сообщения, настройки, снимок для сохранения. */
  const show = (conversation: Conversation | null) => {
    openIdRef.current = conversation?.id ?? null;
    saver.reset(conversation);
    setTitle(conversation?.title ?? null);
    setActionError(null);
    setSidebarOpen(false);
    if (conversation === null) {
      setNotice(null);
      apply({ type: "load", messages: [] });
      return;
    }
    const restored = fromApiSettings(conversation.settings);
    const available = models.some((m) => m.id === restored.model);
    setNotice(available ? null : `Модель ${restored.model} недоступна, выбрана ${firstModel}`);
    const nextModel = available ? restored.model : firstModel;
    settingsRef.current = {
      model: nextModel,
      systemPrompt: restored.draft.systemPrompt,
      temperature: parseTemperature(restored.draft.temperature),
      maxTokens: parseMaxTokens(restored.draft.maxTokens),
      reasoningEffort:
        restored.draft.reasoningEffort === "" ? null : restored.draft.reasoningEffort,
    };
    setModel(nextModel);
    setDraft(restored.draft);
    apply({ type: "load", messages: fromApiMessages(conversation.messages, 0) });
  };

  /** Открыть диалог `target`: остановить стрим, дождаться сохранения прежнего, загрузить. */
  const switchTo = (target: string | null, isCancelled: () => boolean) => {
    void (async () => {
      if (target !== null) setLoading({ kind: "loading" });
      if (target !== openIdRef.current) {
        if (stateRef.current.streamingId !== null) stop();
        const saved = await saver.flush();
        if (isCancelled()) return;
        if (!saved && !window.confirm("Есть несохранённые изменения. Всё равно уйти?")) {
          // остаёмся: адрес возвращается к открытому диалогу
          setLoading({ kind: "ready" });
          window.location.replace(hashFor(openIdRef.current));
          return;
        }
      }
      if (target === null) {
        setLoading({ kind: "ready" });
        show(null);
        return;
      }
      setLoading({ kind: "loading" });
      try {
        const conversation = await api.getConversation(target);
        if (isCancelled()) return;
        setLoading({ kind: "ready" });
        show(conversation);
      } catch (error) {
        if (isCancelled()) return;
        if (error instanceof ApiError && error.status === 404) {
          openIdRef.current = target;
          saver.reset(null);
          apply({ type: "load", messages: [] });
          setTitle(null);
          setLoading({ kind: "missing" });
          setItems((current) => current?.filter((item) => item.id !== target) ?? current);
        } else {
          setLoading({ kind: "error", message: userMessage(error) });
        }
      }
    })();
  };

  const onRoute = useEffectEvent((target: string | null, isCancelled: () => boolean) => {
    // свой только что созданный диалог (адрес сменили мы сами) не перезагружается
    if (target !== null && target === openIdRef.current) return;
    switchTo(target, isCancelled);
  });

  useEffect(() => {
    let cancelled = false;
    onRoute(conversationId, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  /** Перечитать открытый диалог (после 409 или ошибки загрузки); несохранённое теряется. */
  const reload = () => {
    const id = loading.kind === "error" ? conversationId : openIdRef.current;
    saver.reset(null);
    openIdRef.current = id;
    switchTo(id, () => false);
  };

  const rename = (value: string) => {
    const id = openIdRef.current;
    if (id === null) return;
    api.patchConversation(id, { title: value }).then(
      (meta) => {
        setTitle(meta.title);
        setItems(
          (current) =>
            current?.map((item) => (item.id === id ? { ...item, title: meta.title } : item)) ??
            current,
        );
      },
      (error: unknown) => {
        setActionError(userMessage(error));
      },
    );
  };

  const remove = () => {
    const id = openIdRef.current;
    if (id === null || !window.confirm(`Удалить диалог «${title ?? ""}»?`)) return;
    controllerRef.current?.abort();
    controllerRef.current = null;
    api.deleteConversation(id).then(
      () => {
        show(null);
        setItems((current) => current?.filter((item) => item.id !== id) ?? current);
        setReloadKey((key) => key + 1);
        window.location.hash = "chat";
      },
      (error: unknown) => {
        setActionError(userMessage(error));
      },
    );
  };

  if (models.length === 0) {
    return (
      <p className="sheet muted">
        В models.yaml нет чат-моделей. Добавьте модель с backend: ollama и перезапустите шлюз.
      </p>
    );
  }

  const ready = loading.kind === "ready";
  const status = saver.status;

  return (
    <div className="chat-layout">
      <aside className={sidebarOpen ? "chat-sidebar chat-sidebar-open" : "chat-sidebar"}>
        <ConversationList
          activeId={saver.conversationId ?? (loading.kind === "ready" ? null : conversationId)}
          items={items}
          onItemsChange={setItems}
          onNew={() => {
            setSidebarOpen(false);
            window.location.hash = "chat";
          }}
          reloadKey={reloadKey}
          deps={{ listConversations: api.listConversations }}
        />
      </aside>

      <div className="chat">
        <div className="toolbar chat-toolbar">
          <div className="row">
            <button
              type="button"
              className="button-secondary chat-sidebar-toggle"
              aria-expanded={sidebarOpen}
              onClick={() => {
                setSidebarOpen((open) => !open);
              }}
            >
              Диалоги
            </button>
            <div className="field">
              <label htmlFor="chat-model">Модель</label>
              <select
                id="chat-model"
                value={model}
                onChange={(event) => {
                  setNotice(null);
                  changeSettings(event.target.value, draft);
                }}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <ChatSettings
            value={draft}
            onChange={(value) => {
              changeSettings(model, value);
            }}
          />
        </div>

        {notice !== null && <p className="chat-notice">{notice}</p>}
        {actionError !== null && <ErrorBanner message={actionError} />}

        {ready && title !== null && (
          <ConversationHeader
            title={title}
            saving={status.kind === "saving"}
            onRename={rename}
            onDelete={remove}
          />
        )}

        {loading.kind === "loading" && <p className="muted">Загрузка…</p>}
        {loading.kind === "error" && <ErrorBanner message={loading.message} onRetry={reload} />}
        {loading.kind === "missing" && (
          <div className="record-missing">
            <p>Диалог не найден — возможно, его удалили</p>
            <a href="#chat">Новый чат</a>
          </div>
        )}

        {ready &&
          (state.messages.length === 0 ? (
            <div className="chat-empty">
              <p className="chat-empty-title">О чём спросить {model}?</p>
              <p className="muted">
                Картинку можно вставить из буфера или перетащить в поле ввода. Диалог сохраняется в
                историю — он появится в списке слева.
              </p>
            </div>
          ) : (
            <MessageList
              messages={state.messages}
              busy={busy || conflict}
              onEdit={(id, text) => {
                run({ type: "edit", id, text });
              }}
              onRegenerate={() => {
                run({ type: "regenerate" });
              }}
            />
          ))}

        {status.kind === "error" && (
          <div className="chat-save-error" role="status">
            <span>Не сохранено: {status.message}</span>
            <button type="button" className="button-secondary" onClick={saver.retry}>
              Повторить сохранение
            </button>
          </div>
        )}
        {conflict && (
          <div className="chat-save-error" role="status">
            <span>Диалог изменён в другой вкладке</span>
            <button type="button" className="button-secondary" onClick={reload}>
              Загрузить заново
            </button>
          </div>
        )}

        {ready && (
          <Composer
            disabled={conflict}
            streaming={busy}
            onSend={(text, images) => {
              run({ type: "send", text, images });
            }}
            onStop={stop}
          />
        )}
      </div>
    </div>
  );
}
