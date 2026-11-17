import { useState } from "react";
import { Markdown } from "../chat/Markdown";
import { diffWords } from "./diff";
import {
  applyEdit,
  editStatus,
  parseAnswer,
  revertEdit,
  type Edit,
  type EditStatus,
} from "./edits";

interface Props {
  content: string;
  /** Текущий текст документа: по нему считается, применена ли правка. */
  doc: string;
  /** `false` — документ нельзя менять (конфликт с другой вкладкой). */
  canApply: boolean;
  onApply: (text: string, at: number) => void;
}

/** Что было до применения в этой сессии: «Отменить» возвращает текст ровно как был. */
interface Done {
  before: string;
  after: string;
  at: number;
}

const STATUS_TEXT: { [K in EditStatus]: string } = {
  pending: "Модель пишет правку…",
  applicable: "Предлагаемая правка",
  applied: "Правка применена",
  ambiguous: "Фрагмент встречается в документе несколько раз — уточните, какое место менять",
  missing: "Фрагмент не найден в документе — текст изменился или модель неточно его процитировала",
  noop: "Правка ничего не меняет",
};

/** Ключ части — её положение в тексте: части только дописываются в конец (стрим). */
function keyed<T extends { kind: string; text: string }>(parts: T[]) {
  let offset = 0;
  return parts.map((part) => {
    const key = `${part.kind}-${String(offset)}`;
    offset += part.text.length;
    return { key, part };
  });
}

const BLOCKED = "Документ изменён в другой вкладке — сначала загрузите его заново";

function EditCard({
  edit,
  status,
  canApply,
  onApply,
  onRevert,
}: {
  edit: Edit;
  status: EditStatus;
  canApply: boolean;
  onApply: (() => void) | null;
  onRevert: (() => void) | null;
}) {
  const append = edit.search.trim() === "";
  const title =
    append && (status === "applicable" || status === "pending")
      ? "Дописать в конец документа"
      : STATUS_TEXT[status];
  return (
    <div className="doc-edit" data-status={status} role="group" aria-label="Правка документа">
      <div className="doc-edit-head">
        <span className="doc-edit-title">{title}</span>
        {onApply !== null && (
          <button
            type="button"
            disabled={!canApply}
            title={canApply ? undefined : BLOCKED}
            onClick={onApply}
          >
            Применить
          </button>
        )}
        {onRevert !== null && (
          <button
            type="button"
            className="button-secondary"
            disabled={!canApply}
            title={canApply ? undefined : BLOCKED}
            onClick={onRevert}
          >
            Отменить
          </button>
        )}
      </div>
      <pre className="doc-edit-diff">
        {keyed(diffWords(edit.search, edit.replace)).map(({ key, part }) =>
          part.kind === "same" ? (
            <span key={key}>{part.text}</span>
          ) : part.kind === "del" ? (
            <del key={key}>{part.text}</del>
          ) : (
            <ins key={key}>{part.text}</ins>
          ),
        )}
      </pre>
    </div>
  );
}

/** Ответ модели на вопрос к документу: текст — Markdown, блоки правки — карточки с разницей. */
export function EditableAnswer({ content, doc, canApply, onApply }: Props) {
  const [records, setRecords] = useState<ReadonlyMap<number, Done>>(new Map());
  const segments = parseAnswer(content);
  const edits = segments.flatMap((segment, index) =>
    segment.kind === "edit" ? [{ index, edit: segment.edit }] : [],
  );
  const statuses = new Map(edits.map(({ index, edit }) => [index, editStatus(doc, edit)]));
  const applicable = edits.filter(({ index }) => statuses.get(index) === "applicable");

  const remember = (entries: [number, Done][]) => {
    setRecords((current) => new Map([...current, ...entries]));
  };

  const apply = (index: number, edit: Edit) => {
    const result = applyEdit(doc, edit);
    if (!result.ok) return;
    remember([[index, { before: doc, after: result.text, at: result.at }]]);
    onApply(result.text, result.at);
  };

  const applyAll = () => {
    let text = doc;
    let at: number | null = null;
    const entries: [number, Done][] = [];
    for (const { index, edit } of applicable) {
      const result = applyEdit(text, edit);
      if (!result.ok) continue;
      entries.push([index, { before: text, after: result.text, at: result.at }]);
      text = result.text;
      at ??= result.at;
    }
    if (at === null) return;
    remember(entries);
    onApply(text, at);
  };

  const revertAction = (index: number, edit: Edit): (() => void) | null => {
    const record = records.get(index);
    if (record !== undefined && record.after === doc) {
      return () => {
        onApply(record.before, record.at);
      };
    }
    const result = revertEdit(doc, edit);
    if (!result.ok) return null;
    return () => {
      onApply(result.text, result.at);
    };
  };

  return (
    <div className="doc-answer">
      {segments.map((segment, index) =>
        segment.kind === "text" ? (
          <Markdown key={`text-${String(index)}`} text={segment.text} />
        ) : (
          <EditCard
            key={`edit-${String(index)}`}
            edit={segment.edit}
            status={statuses.get(index) ?? "pending"}
            canApply={canApply}
            onApply={
              statuses.get(index) === "applicable"
                ? () => {
                    apply(index, segment.edit);
                  }
                : null
            }
            onRevert={statuses.get(index) === "applied" ? revertAction(index, segment.edit) : null}
          />
        ),
      )}
      {applicable.length > 1 && (
        <button
          type="button"
          className="doc-edit-all"
          disabled={!canApply}
          title={canApply ? undefined : BLOCKED}
          onClick={applyAll}
        >
          Применить все правки ({applicable.length})
        </button>
      )}
    </div>
  );
}
