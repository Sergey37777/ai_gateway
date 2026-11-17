import { useCallback, useDeferredValue, useEffect, useEffectEvent, useRef, useState } from "react";
import { streamChat as defaultStreamChat } from "../api/chat";
import * as conversationsApi from "../api/conversations";
import * as documentsApi from "../api/documents";
import { ApiError, userMessage } from "../api/errors";
import type { ApiDocument, DocumentItem } from "../api/types";
import { ErrorBanner } from "../components/ErrorBanner";
import { documentHash } from "../route";
import type { ScreenProps } from "../screen";
import { AskButton } from "./AskButton";
import { buildContext } from "./context";
import { DocumentHeader, type ViewMode } from "./DocumentHeader";
import { DocumentList, type UploadProgress } from "./DocumentList";
import { DocumentView } from "./DocumentView";
import { questionsLabel } from "./format";
import { downloadText } from "./download";
import { DocumentOutline } from "./DocumentOutline";
import { outline, type Heading } from "./outline";
import { QuestionPanel } from "./QuestionPanel";
import type { Draft } from "./QuestionThread";
import { findQuote, sourceRange } from "./selection";
import { SourceEditor, type SourceEditorHandle, type SourceSelection } from "./SourceEditor";
import { importFiles, type UploadError } from "./importFiles";
import { useDocumentSaver } from "./useDocumentSaver";

type Api = typeof documentsApi &
  typeof conversationsApi & {
    streamChat: typeof defaultStreamChat;
  };

interface Props extends ScreenProps {
  /** `#documents/<id>` — открытый документ; `null` — ни одного. */
  documentId: string | null;
  /** `#documents/<id>/<questionId>` — открытый вопрос. */
  questionId: string | null;
  /** Вкладка показана: при показе список перечитывается. */
  visible: boolean;
  /** Подмена API в тестах. */
  deps?: Partial<Api>;
}

type Loading =
  | { kind: "ready" }
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; message: string };

interface Ask {
  quote: string;
  range: { start: number; end: number };
  at: { x: number; y: number } | null;
}

const NEW_TITLE = "Без названия";
const FLASH_MS = 1600;
const REVEAL_DELAY_MS = 120;

function modeKey(id: string): string {
  return `aigw.documents.mode.${id}`;
}

/** Режим просмотра — удобство одного браузера; хранилище может быть недоступно. */
function readMode(id: string): ViewMode {
  try {
    const value = window.localStorage.getItem(modeKey(id));
    return value === "split" || value === "source" ? value : "preview";
  } catch {
    return "preview";
  }
}

function storeMode(id: string, mode: ViewMode): void {
  try {
    window.localStorage.setItem(modeKey(id), mode);
  } catch {
    // приватный режим — режим просто не запомнится
  }
}

function useNarrow(query: string): boolean {
  const media = typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
  const [matches, setMatches] = useState(media?.matches ?? false);
  useEffect(() => {
    if (media === null) return undefined;
    const onChange = () => {
      setMatches(media.matches);
    };
    media.addEventListener("change", onChange);
    return () => {
      media.removeEventListener("change", onChange);
    };
  }, [media]);
  return matches;
}

/** Блок превью, в котором лежит смещение исходника (самый глубокий). */
function blockAt(root: HTMLElement, offset: number): HTMLElement | null {
  let found: HTMLElement | null = null;
  for (const element of root.querySelectorAll<HTMLElement>("[data-src-start]")) {
    const start = Number(element.dataset["srcStart"]);
    const end = Number(element.dataset["srcEnd"]);
    if (start <= offset && offset < end) found = element;
  }
  return found;
}

export function DocumentsScreen({
  config,
  onDirtyChange,
  documentId,
  questionId,
  visible,
  deps,
}: Props) {
  const api: Api = { ...documentsApi, ...conversationsApi, streamChat: defaultStreamChat, ...deps };
  const models = config.models.filter((m) => m.kind === "chat").map((m) => m.id);
  const narrow = useNarrow("(width < 1000px)");

  const [items, setItems] = useState<DocumentItem[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [current, setCurrent] = useState<ApiDocument | null>(null);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState<Loading>({ kind: "ready" });
  const [mode, setMode] = useState<ViewMode>("preview");
  const [questionsOpen, setQuestionsOpen] = useState(questionId !== null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [uploading, setUploading] = useState<UploadProgress | null>(null);
  const [uploadErrors, setUploadErrors] = useState<UploadError[]>([]);
  const [uploadNotes, setUploadNotes] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [questionBusy, setQuestionBusy] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [activeHeading, setActiveHeading] = useState<string | null>(null);
  const openIdRef = useRef<string | null>(null);
  const draftKey = useRef(0);
  const previewRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<SourceEditorHandle>(null);
  const preview = useDeferredValue(text);

  const updateItem = useCallback((id: string, change: Partial<DocumentItem>, toTop: boolean) => {
    setItems((list) => {
      if (list === null) return list;
      const found = list.find((item) => item.id === id);
      if (found === undefined) return list;
      const next = { ...found, ...change };
      const rest = list.filter((item) => item.id !== id);
      return toTop ? [next, ...rest] : list.map((item) => (item.id === id ? next : item));
    });
  }, []);

  const saver = useDocumentSaver({
    writeText: api.writeText,
    onSaved: (result) => {
      const id = openIdRef.current;
      if (id === null) return;
      setCurrent((doc) => (doc === null ? doc : { ...doc, ...result }));
      updateItem(id, { chars: result.chars, updated_at: result.updated_at }, true);
    },
  });
  const conflict = saver.status.kind === "conflict";

  useEffect(() => {
    onDirtyChange(saver.unsaved || questionBusy);
  }, [saver.unsaved, questionBusy, onDirtyChange]);

  const [shownVisible, setShownVisible] = useState(visible);
  if (visible !== shownVisible) {
    setShownVisible(visible);
    if (visible) setReloadKey((key) => key + 1);
  }

  // вопрос в адресе — панель вопросов открыта
  const [seenQuestion, setSeenQuestion] = useState(questionId);
  if (questionId !== seenQuestion) {
    setSeenQuestion(questionId);
    if (questionId !== null) setQuestionsOpen(true);
  }

  const show = (doc: ApiDocument | null) => {
    openIdRef.current = doc?.id ?? null;
    saver.reset(doc);
    setCurrent(doc);
    setText(doc?.text ?? "");
    setMode(doc === null ? "preview" : readMode(doc.id));
    setDraft(null);
    setAsk(null);
    setNotice(null);
    setActionError(null);
    setOutlineOpen(false);
    setSidebarOpen(false);
  };

  const open = async (target: string, isCancelled: () => boolean) => {
    setLoading({ kind: "loading" });
    try {
      const doc = await api.getDocument(target);
      if (isCancelled()) return;
      setLoading({ kind: "ready" });
      show(doc);
    } catch (error) {
      if (isCancelled()) return;
      show(null);
      openIdRef.current = target;
      if (error instanceof ApiError && error.status === 404) {
        setLoading({ kind: "missing" });
        setItems((list) => list?.filter((item) => item.id !== target) ?? list);
      } else {
        setLoading({ kind: "error", message: userMessage(error) });
      }
    }
  };

  /** Открыть документ `target`: дописать правку прежнего, загрузить новый. */
  const switchTo = (target: string | null, isCancelled: () => boolean) => {
    void (async () => {
      if (openIdRef.current !== null) {
        const saved = await saver.flush();
        if (isCancelled()) return;
        if (!saved && !window.confirm("Есть несохранённые изменения. Всё равно уйти?")) {
          const id = openIdRef.current;
          window.location.replace(documentHash(id));
          return;
        }
      }
      if (target === null) {
        setLoading({ kind: "ready" });
        show(null);
        return;
      }
      await open(target, isCancelled);
    })();
  };

  const onRoute = useEffectEvent((target: string | null, isCancelled: () => boolean) => {
    if (target === openIdRef.current && loading.kind !== "error") return;
    switchTo(target, isCancelled);
  });

  useEffect(() => {
    let cancelled = false;
    onRoute(documentId, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  const headings: Heading[] = current?.format === "markdown" ? outline(preview) : [];
  const effectiveMode: ViewMode = narrow && mode === "split" ? "preview" : mode;
  const showOutlineColumn = effectiveMode === "preview" && !narrow && headings.length > 0;

  // текущий раздел в оглавлении — по прокрутке превью
  useEffect(() => {
    const root = previewRef.current;
    if (root === null || typeof IntersectionObserver !== "function" || headings.length === 0) {
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const visibleHeading = entries.find((entry) => entry.isIntersecting);
        if (visibleHeading !== undefined) setActiveHeading(visibleHeading.target.id);
      },
      { rootMargin: "0px 0px -70% 0px" },
    );
    for (const heading of root.querySelectorAll("h1[id], h2[id], h3[id], h4[id]")) {
      observer.observe(heading);
    }
    return () => {
      observer.disconnect();
    };
  });

  // снятое выделение убирает кнопку «Спросить модель» (в превью)
  useEffect(() => {
    if (ask === null || ask.at === null) return undefined;
    const onChange = () => {
      if (window.getSelection()?.isCollapsed ?? true) setAsk(null);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      document.removeEventListener("selectionchange", onChange);
    };
  }, [ask]);

  const edit = (value: string) => {
    setText(value);
    saver.edit(value);
  };

  /** Правка модели из панели вопросов: как ручная правка, плюс показать изменённое место. */
  const applyModelEdit = (value: string, at: number) => {
    if (conflict) return;
    edit(value);
    setNotice(null);
    // превью перерисуется с отложенным текстом — показать место чуть позже
    window.setTimeout(() => {
      if (effectiveMode !== "preview") editorRef.current?.scrollToOffset(at);
      if (effectiveMode !== "source") scrollPreviewTo(at);
    }, REVEAL_DELAY_MS);
  };

  const changeMode = (value: ViewMode) => {
    setMode(value);
    setAsk(null);
    if (current !== null) storeMode(current.id, value);
  };

  const onPreviewSelection = () => {
    const root = previewRef.current;
    const selection = window.getSelection();
    if (root === null || selection === null || selection.isCollapsed) {
      setAsk(null);
      return;
    }
    if (selection.anchorNode === null || !root.contains(selection.anchorNode)) return;
    const quote = selection.toString().trim();
    if (quote === "") return;
    const range = selection.getRangeAt(0);
    const rect =
      typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
    setAsk({
      quote,
      range: sourceRange(root, selection, text),
      at: rect === null ? { x: 0, y: 0 } : { x: rect.right, y: rect.bottom },
    });
  };

  const onEditorSelection = (selection: SourceSelection | null) => {
    if (selection === null || selection.text.trim() === "") {
      setAsk((value) => (value?.at === null ? null : value));
      return;
    }
    setAsk({
      quote: selection.text.trim(),
      range: { start: selection.start, end: selection.end },
      at: null,
    });
  };

  const startQuestion = () => {
    if (ask === null) return;
    draftKey.current += 1;
    setDraft({ key: draftKey.current, quote: ask.quote, context: buildContext(text, ask.range) });
    setQuestionsOpen(true);
    setAsk(null);
    window.getSelection()?.removeAllRanges();
  };

  const scrollPreviewTo = (offset: number) => {
    const root = previewRef.current;
    const block = root === null ? null : blockAt(root, offset);
    if (block === null) return false;
    // в jsdom scrollIntoView нет
    if (typeof block.scrollIntoView === "function") {
      block.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    block.classList.add("doc-flash");
    window.setTimeout(() => {
      block.classList.remove("doc-flash");
    }, FLASH_MS);
    return true;
  };

  const showQuote = (quote: string) => {
    const index = findQuote(text, quote);
    if (index < 0) {
      setNotice("Этот фрагмент изменён — в документе его больше нет");
      return;
    }
    setNotice(null);
    if (effectiveMode === "source") editorRef.current?.scrollToOffset(index);
    else scrollPreviewTo(index);
  };

  const goToHeading = (heading: Heading) => {
    setOutlineOpen(false);
    if (effectiveMode === "source") {
      editorRef.current?.scrollToOffset(heading.start);
      return;
    }
    const target = previewRef.current?.querySelector(`[id="${CSS.escape(heading.id)}"]`);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveHeading(heading.id);
  };

  // «Рядом»: прокрутка редактора ведёт превью
  const followEditor = (offset: number) => {
    const pane = paneRef.current;
    const root = previewRef.current;
    if (pane === null || root === null || effectiveMode !== "split") return;
    let target: HTMLElement | null = null;
    for (const element of root.querySelectorAll<HTMLElement>(".doc-body > [data-src-start]")) {
      if (Number(element.dataset["srcStart"]) <= offset) target = element;
      else break;
    }
    if (target === null) {
      pane.scrollTop = 0;
      return;
    }
    pane.scrollTop =
      target.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 12;
  };

  const createNew = () => {
    api
      .createDocument({
        title: NEW_TITLE,
        filename: `${NEW_TITLE}.md`,
        format: "markdown",
        text: "",
      })
      .then(
        (doc) => {
          storeMode(doc.id, "split");
          setReloadKey((key) => key + 1);
          window.location.hash = documentHash(doc.id);
        },
        (error: unknown) => {
          setActionError(userMessage(error));
        },
      );
  };

  const upload = (files: File[]) => {
    void (async () => {
      setUploading({ done: 0, total: 0 });
      setUploadErrors([]);
      setUploadNotes([]);
      const result = await importFiles(files, {
        maxMb: config.max_document_mb,
        create: api.createDocument,
        onProgress: (done, total) => {
          setUploading({ done, total });
        },
      });
      setUploadErrors(result.errors);
      setUploadNotes(result.notes);
      setUploading(null);
      if (result.last !== null) {
        setReloadKey((key) => key + 1);
        window.location.hash = documentHash(result.last.id);
      }
    })();
  };

  const rename = (value: string) => {
    const id = openIdRef.current;
    if (id === null) return;
    api.renameDocument(id, value).then(
      (meta) => {
        setCurrent((doc) => (doc === null ? doc : { ...doc, ...meta }));
        updateItem(id, meta, true);
      },
      (error: unknown) => {
        setActionError(userMessage(error));
      },
    );
  };

  const remove = () => {
    if (current === null) return;
    const count = current.question_count;
    const suffix = count > 0 ? ` и ${questionsLabel(count)}` : "";
    if (!window.confirm(`Удалить документ «${current.title}»${suffix}?`)) return;
    const id = current.id;
    api.deleteDocument(id).then(
      () => {
        show(null);
        setItems((list) => list?.filter((item) => item.id !== id) ?? list);
        setReloadKey((key) => key + 1);
        window.location.hash = "documents";
      },
      (error: unknown) => {
        setActionError(userMessage(error));
      },
    );
  };

  const reloadAfterConflict = () => {
    const id = openIdRef.current;
    if (id === null) return;
    if (!window.confirm("Ваши несохранённые правки пропадут. Загрузить документ заново?")) return;
    saver.reset(null);
    void open(id, () => false);
  };

  const changeCount = (delta: number) => {
    const id = openIdRef.current;
    if (id === null) return;
    setCurrent((doc) =>
      doc === null ? doc : { ...doc, question_count: Math.max(0, doc.question_count + delta) },
    );
    setItems(
      (list) =>
        list?.map((item) =>
          item.id === id
            ? { ...item, question_count: Math.max(0, item.question_count + delta) }
            : item,
        ) ?? list,
    );
  };

  const status = saver.status;
  const saveLabel =
    status.kind === "saving" || (saver.unsaved && status.kind === "idle")
      ? "Сохраняется…"
      : status.kind === "idle"
        ? "Сохранено"
        : null;

  return (
    <div className="docs-layout">
      <aside
        className={
          sidebarOpen ? "chat-sidebar docs-sidebar docs-sidebar-open" : "chat-sidebar docs-sidebar"
        }
      >
        <DocumentList
          activeId={current?.id ?? (loading.kind === "ready" ? null : documentId)}
          items={items}
          onItemsChange={setItems}
          reloadKey={reloadKey}
          onNew={createNew}
          onUpload={upload}
          uploading={uploading}
          uploadErrors={uploadErrors}
          uploadNotes={uploadNotes}
          deps={{ listDocuments: api.listDocuments }}
        />
      </aside>

      <div className="docs-main">
        <button
          type="button"
          className="button-secondary docs-sidebar-toggle"
          aria-expanded={sidebarOpen}
          onClick={() => {
            setSidebarOpen((value) => !value);
          }}
        >
          Документы
        </button>

        {actionError !== null && <ErrorBanner message={actionError} />}
        {loading.kind === "loading" && <p className="muted">Загрузка…</p>}
        {loading.kind === "error" && (
          <ErrorBanner
            message={loading.message}
            onRetry={() => {
              if (documentId !== null) void open(documentId, () => false);
            }}
          />
        )}
        {loading.kind === "missing" && (
          <div className="record-missing">
            <p>Документ не найден — возможно, его удалили</p>
            <a href="#documents">К документам</a>
          </div>
        )}

        {loading.kind === "ready" && current === null && (
          <div className="docs-empty">
            <p className="chat-empty-title">Документы</p>
            <p className="muted">
              Загрузите .md или .txt — по одному или архивом (или создайте новый), читайте в
              красивом превью, правьте рядом с исходником и спрашивайте модель о непонятных местах —
              выделите текст и нажмите «Спросить модель».
            </p>
          </div>
        )}

        {loading.kind === "ready" && current !== null && (
          <>
            <DocumentHeader
              title={current.title}
              mode={effectiveMode}
              canSplit={!narrow}
              onMode={changeMode}
              saveLabel={saveLabel}
              questionCount={current.question_count}
              questionsOpen={questionsOpen}
              onToggleQuestions={() => {
                const next = !questionsOpen;
                setQuestionsOpen(next);
                // черновик живёт, пока панель открыта: повторное открытие — список вопросов
                if (!next) setDraft(null);
                if (!next && questionId !== null) window.location.hash = documentHash(current.id);
              }}
              onRename={rename}
              onDownload={() => {
                downloadText(text, current.filename, current.format);
              }}
              onDelete={remove}
              onOutline={
                headings.length > 0 && !showOutlineColumn
                  ? () => {
                      setOutlineOpen((value) => !value);
                    }
                  : null
              }
            />
            {outlineOpen && !showOutlineColumn && (
              <div className="doc-outline-popover">
                <DocumentOutline
                  headings={headings}
                  activeId={activeHeading}
                  onSelect={goToHeading}
                />
              </div>
            )}
            {notice !== null && <p className="chat-notice">{notice}</p>}
            {status.kind === "error" && (
              <div className="chat-save-error" role="status">
                <span>Не сохранено: {status.message}</span>
                <button type="button" className="button-secondary" onClick={saver.retry}>
                  Повторить
                </button>
              </div>
            )}
            {conflict && (
              <div className="chat-save-error" role="status">
                <span>Документ изменён в другой вкладке</span>
                <button type="button" className="button-secondary" onClick={reloadAfterConflict}>
                  Загрузить заново
                </button>
                <button
                  type="button"
                  className="button-secondary"
                  onClick={() => {
                    downloadText(text, current.filename, current.format);
                  }}
                >
                  Скачать мою версию
                </button>
              </div>
            )}

            <div
              className={[
                "docs-workspace",
                `docs-mode-${effectiveMode}`,
                showOutlineColumn ? "docs-with-outline" : "",
                questionsOpen ? "docs-with-questions" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {showOutlineColumn && (
                <div className="docs-outline-column">
                  <DocumentOutline
                    headings={headings}
                    activeId={activeHeading}
                    onSelect={goToHeading}
                  />
                </div>
              )}
              {effectiveMode !== "preview" && (
                <div className="docs-pane docs-source">
                  <SourceEditor
                    ref={editorRef}
                    value={text}
                    readOnly={conflict}
                    onChange={edit}
                    onSelection={onEditorSelection}
                    onTopLine={followEditor}
                  />
                  {ask !== null && ask.at === null && (
                    <AskButton quote={ask.quote} at={null} onAsk={startQuestion} />
                  )}
                </div>
              )}
              {effectiveMode !== "source" && (
                <div
                  className="docs-pane docs-preview"
                  ref={paneRef}
                  data-testid="doc-preview"
                  onMouseUp={onPreviewSelection}
                  onKeyUp={onPreviewSelection}
                >
                  {text.trim() === "" ? (
                    <p className="muted doc-blank">Документ пуст — начните писать в исходнике.</p>
                  ) : (
                    <DocumentView ref={previewRef} text={preview} format={current.format} />
                  )}
                </div>
              )}
              {questionsOpen && (
                <QuestionPanel
                  key={current.id}
                  document={{ id: current.id, title: current.title, text }}
                  draft={draft}
                  questionId={questionId}
                  models={models}
                  deps={api}
                  onClose={() => {
                    setQuestionsOpen(false);
                    setDraft(null);
                    if (questionId !== null) window.location.hash = documentHash(current.id);
                  }}
                  onOpen={(id) => {
                    window.location.hash = documentHash(current.id, id);
                  }}
                  onCreated={(id) => {
                    // вопрос сохранён: черновик больше не нужен (панель держит открытый вопрос сама)
                    setDraft(null);
                    window.location.replace(documentHash(current.id, id));
                  }}
                  onCountChange={changeCount}
                  onQuoteClick={showQuote}
                  onBusyChange={setQuestionBusy}
                  onApplyEdit={applyModelEdit}
                  canEdit={!conflict}
                />
              )}
            </div>
            {ask !== null && ask.at !== null && (
              <AskButton quote={ask.quote} at={ask.at} onAsk={startQuestion} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
