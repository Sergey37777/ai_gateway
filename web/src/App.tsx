import { useCallback, useEffect, useState } from "react";
import { getApiKey, onUnauthorized, setApiKey } from "./api/apiKey";
import { fetchConfig } from "./api/config";
import { userMessage } from "./api/errors";
import type { UiConfig } from "./api/types";
import { ApiKeyDialog } from "./components/ApiKeyDialog";
import { ErrorBanner } from "./components/ErrorBanner";
import type { ScreenProps } from "./screen";

type Tab = "transcribe" | "chat";

const TABS: { id: Tab; label: string }[] = [
  { id: "transcribe", label: "Распознавание" },
  { id: "chat", label: "Чат" },
];

function tabFromHash(hash: string): Tab {
  return hash === "#chat" ? "chat" : "transcribe";
}

type ConfigState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; config: UiConfig };

// временные заглушки — экраны появляются в следующих задачах плана
function TranscribePlaceholder(_props: ScreenProps) {
  return <p className="muted">Распознавание появится здесь.</p>;
}
function ChatPlaceholder(_props: ScreenProps) {
  return <p className="muted">Чат появится здесь.</p>;
}

export function App() {
  const [configState, setConfigState] = useState<ConfigState>({ status: "loading" });
  const [tab, setTab] = useState<Tab>(() => tabFromHash(window.location.hash));
  // null — диалог скрыт; строка — показан с этим сообщением ("" — без сообщения)
  const [keyPrompt, setKeyPrompt] = useState<string | null>(null);
  const [dirty, setDirty] = useState<Record<Tab, boolean>>({ transcribe: false, chat: false });

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
      setTab(tabFromHash(window.location.hash));
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
    // истории нет: перезагрузка страницы теряет результат и диалог
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
    setTab(id);
    window.location.hash = id;
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>ai_gateway</h1>
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
              <TranscribePlaceholder
                config={configState.config}
                onDirtyChange={onTranscribeDirty}
              />
            </section>
            <section
              role="tabpanel"
              id="panel-chat"
              aria-labelledby="tab-chat"
              hidden={tab !== "chat"}
            >
              <ChatPlaceholder config={configState.config} onDirtyChange={onChatDirty} />
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
