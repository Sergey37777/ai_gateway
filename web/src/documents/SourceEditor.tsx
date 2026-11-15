import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

export interface SourceSelection {
  start: number;
  end: number;
  text: string;
}

export interface SourceEditorHandle {
  scrollToOffset: (offset: number) => void;
  focus: () => void;
}

interface Props {
  value: string;
  readOnly: boolean;
  onChange: (text: string) => void;
  /** Непустое выделение (или `null`) — для «Спросить». */
  onSelection: (selection: SourceSelection | null) => void;
  /** Смещение первой видимой строки — превью прокручивается следом. */
  onTopLine: (offset: number) => void;
  ref?: Ref<SourceEditorHandle>;
}

/** Транзакция заменила текст по новому `value`, это не правка пользователя. */
const external = Annotation.define<boolean>();

/** Цвета — из токенов UI: тема одна на светлую и тёмную. */
const HIGHLIGHT = HighlightStyle.define([
  { tag: tags.heading, color: "var(--signal)", fontWeight: "650" },
  { tag: tags.strong, fontWeight: "650" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--signal)" },
  { tag: [tags.monospace, tags.string], color: "var(--code-string, #1f7a45)" },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: "var(--graphite)" },
  { tag: tags.quote, color: "var(--graphite)", fontStyle: "italic" },
  { tag: tags.list, color: "var(--signal)" },
  { tag: [tags.keyword, tags.typeName], color: "var(--code-keyword, #8a2bbf)" },
  { tag: [tags.number, tags.bool], color: "var(--code-number, #a8520a)" },
  { tag: tags.comment, color: "var(--graphite)", fontStyle: "italic" },
  {
    tag: [tags.function(tags.variableName), tags.propertyName],
    color: "var(--code-attr, #b23c50)",
  },
]);

const THEME = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--ink)",
    backgroundColor: "var(--sheet)",
    fontSize: "14px",
  },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--signal)", padding: "12px 0" },
  ".cm-gutters": {
    backgroundColor: "var(--sheet)",
    color: "var(--graphite)",
    border: "none",
    borderRight: "1px solid var(--line)",
  },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--sheet-2)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--signal-soft)",
  },
  ".cm-cursor": { borderLeftColor: "var(--signal)" },
  ".cm-searchMatch": { backgroundColor: "var(--signal-quiet)" },
  ".cm-panels": { backgroundColor: "var(--sheet-2)", color: "var(--ink)" },
  "&.cm-focused": { outline: "none" },
});

/** Исходник документа: CodeMirror 6 с подсветкой Markdown, поиском, переносом строк. */
export function SourceEditor({ value, readOnly, onChange, onSelection, onTopLine, ref }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  const callbacks = useRef({ onChange, onSelection, onTopLine });
  // редактор создаётся один раз с этими значениями; дальше value и readOnly — эффектами ниже
  const initial = useRef({ value, readOnly });
  const lastTop = useRef(-1);
  useEffect(() => {
    callbacks.current = { onChange, onSelection, onTopLine };
  });

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initial.current.value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          search({ top: true }),
          highlightSelectionMatches(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          syntaxHighlighting(HIGHLIGHT),
          EditorView.lineWrapping,
          THEME,
          editable.current.of([
            EditorState.readOnly.of(initial.current.readOnly),
            EditorView.editable.of(!initial.current.readOnly),
          ]),
          EditorView.updateListener.of((update) => {
            // правка пользователя (не смена value снаружи — та помечена аннотацией external)
            if (update.docChanged && !update.transactions.some((t) => t.annotation(external))) {
              callbacks.current.onChange(update.state.doc.toString());
            }
            if (update.selectionSet || update.docChanged) {
              const { from, to } = update.state.selection.main;
              callbacks.current.onSelection(
                from === to
                  ? null
                  : { start: from, end: to, text: update.state.sliceDoc(from, to) },
              );
            }
          }),
          EditorView.domEventHandlers({
            scroll: (_event, current) => {
              const top = current.lineBlockAtHeight(current.scrollDOM.scrollTop).from;
              if (top !== lastTop.current) {
                lastTop.current = top;
                callbacks.current.onTopLine(top);
              }
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null || view.state.doc.toString() === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: external.of(true),
    });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editable.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  useImperativeHandle(ref, () => ({
    scrollToOffset: (offset: number) => {
      const view = viewRef.current;
      if (view === null) return;
      const position = Math.min(offset, view.state.doc.length);
      view.dispatch({ effects: EditorView.scrollIntoView(position, { y: "start", yMargin: 24 }) });
    },
    focus: () => {
      viewRef.current?.focus();
    },
  }));

  return <div className="doc-editor" ref={hostRef} />;
}
