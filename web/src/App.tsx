import { useCallback, useEffect, useState } from "react";
import { getApiKey, onUnauthorized, setApiKey } from "./api/apiKey";
import { fetchConfig } from "./api/config";
import { userMessage } from "./api/errors";
import type { TranscriptionJob, UiConfig } from "./api/types";
import { ApiKeyDialog } from "./components/ApiKeyDialog";
import { ErrorBanner } from "./components/ErrorBanner";
import { ChatScreen } from "./chat/ChatScreen";
import { HistoryScreen } from "./history/HistoryScreen";
import { RecordScreen } from "./history/RecordScreen";
import { parseRoute, recordHash, type Tab } from "./route";
import { TranscribeScreen } from "./transcribe/TranscribeScreen";

const TABS: { id: Tab; label: string }[] = [
  { id: "transcribe", label: "Распознавание" },
  { id: "history", label: "История" },
  { id: "chat", label: "Чат" },
];

type ConfigState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; config: UiConfig };

export function App() {
  const [configState, setConfigState] = useState<ConfigState>({ status: "loading" });
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  const { tab } = route;
  // только что загруженные файлы: запись истории играет их (с видеорядом), а не Opus
  const [recentFiles, setRecentFiles] = useState<ReadonlyMap<string, File>>(() => new Map());
  // null — диалог скрыт; строка — показан с этим сообщением ("" — без сообщения)
  const [keyPrompt, setKeyPrompt] = useState<string | null>(null);
  const [dirty, setDirty] = useState({ transcribe: false, chat: false });

  const load = useCallback(() => {
    fetchConfig().then(
      (config) => {
        setConfigState({ status: "ready", config });
        if (config.auth_required && getApiKey() === null) setKeyPrompt("");
      },
      (error: unknown) => {
        setConfigState({ status: "error", message: userMessage(error) });
      },
    );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const onHash = () => {
      setRoute(parseRoute(window.location.hash));
    };
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
    };
  }, []);

  useEffect(
    () =>
      onUnauthorized(() => {
        setKeyPrompt("Ключ не подошёл");
      }),
    [],
  );

  const anyDirty = dirty.transcribe || dirty.chat;
  useEffect(() => {
    if (!anyDirty) return undefined;
    // идёт загрузка файла или есть несохранённый диалог: перезагрузка их потеряет
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [anyDirty]);

  const onTranscribeDirty = useCallback((value: boolean) => {
    setDirty((d) => (d.transcribe === value ? d : { ...d, transcribe: value }));
  }, []);
  const onChatDirty = useCallback((value: boolean) => {
    setDirty((d) => (d.chat === value ? d : { ...d, chat: value }));
  }, []);

  const selectTab = (id: Tab) => {
    setRoute({ tab: id, recordId: null, conversationId: null });
    window.location.hash = id;
  };

  const onCreated = useCallback((job: TranscriptionJob, file: File) => {
    setRecentFiles((files) => new Map(files).set(job.id, file));
    window.location.hash = recordHash(job.id);
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="brand">
          <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
            <path d="M8 20v-8M12 23V9M16 20v-8M20 25V7M24 20v-8" />
          </svg>
          <span className="brand-name">ai_gateway</span>
        </h1>
        {configState.status === "ready" && (
          <nav role="tablist" className="tabs">
            {TABS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`panel-${id}`}
                onClick={() => {
                  selectTab(id);
                }}
              >
                {label}
              </button>
            ))}
          </nav>
        )}
        {configState.status === "ready" && configState.config.auth_required && (
          <button
            type="button"
            className="button-secondary header-key"
            onClick={() => {
              setKeyPrompt("");
            }}
          >
            Ключ API
          </button>
        )}
      </header>

      <main className="app-main">
        {configState.status === "loading" && <p className="muted">Загрузка…</p>}
        {configState.status === "error" && (
          <ErrorBanner
            message={configState.message}
            onRetry={() => {
              setConfigState({ status: "loading" });
              load();
            }}
          />
        )}
        {configState.status === "ready" && (
          <>
            {/* обе вкладки смонтированы всегда: переключение не теряет состояние */}
            <section
              role="tabpanel"
              id="panel-transcribe"
              aria-labelledby="tab-transcribe"
              hidden={tab !== "transcribe"}
            >
              <TranscribeScreen
                config={configState.config}
                onDirtyChange={onTranscribeDirty}
                onCreated={onCreated}
              />
            </section>
            <section
              role="tabpanel"
              id="panel-history"
              aria-labelledby="tab-history"
              hidden={tab !== "history"}
            >
              {/* история монтируется только открытой: скрытая не опрашивает сервер */}
              {tab === "history" &&
                (route.recordId === null ? (
                  <HistoryScreen />
                ) : (
                  <RecordScreen
                    key={route.recordId}
                    id={route.recordId}
                    localFile={recentFiles.get(route.recordId) ?? null}
                    onDeleted={() => {
                      window.location.hash = "history";
                    }}
                  />
                ))}
            </section>
            <section
              role="tabpanel"
              id="panel-chat"
              aria-labelledby="tab-chat"
              hidden={tab !== "chat"}
            >
              <ChatScreen
                config={configState.config}
                onDirtyChange={onChatDirty}
                conversationId={route.conversationId}
                visible={tab === "chat"}
              />
            </section>
          </>
        )}
      </main>

      {keyPrompt !== null && (
        <ApiKeyDialog
          message={keyPrompt === "" ? null : keyPrompt}
          onSave={(key) => {
            setApiKey(key);
            setKeyPrompt(null);
          }}
          {...(getApiKey() !== null && {
            onCancel: () => {
              setKeyPrompt(null);
            },
          })}
        />
      )}
    </div>
  );
}
