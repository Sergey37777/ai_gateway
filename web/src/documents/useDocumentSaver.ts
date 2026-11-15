/**
 * Автосохранение текста документа: запись через `SAVE_DELAY` после последней правки, строго по
 * одной, с проверкой `revision`. Логика — в классе `DocumentSaver` (без React).
 */

import { useEffect, useState } from "react";
import type { writeText as defaultWriteText } from "../api/documents";
import { ApiError, userMessage } from "../api/errors";
import type { ApiDocument, TextWriteResult } from "../api/types";
import type { SaveStatus } from "../chat/useConversationSaver";

export const SAVE_DELAY = 1500;

export interface DocumentSaverOptions {
  writeText: typeof defaultWriteText;
  /** Текст записан: шапка и список документов обновляют время и размер. */
  onSaved: (result: TextWriteResult) => void;
}

export interface DocumentSaverView {
  status: SaveStatus;
  /** Есть несохранённое или запись в полёте. */
  unsaved: boolean;
}

export class DocumentSaver {
  private id: string | null = null;
  private revision = 0;
  private saved = "";
  private text = "";
  private timer: number | null = null;
  private busy = false;
  private conflict = false;
  // упавшая запись повторяется по retry() или когда текст снова изменился
  private failed: string | null = null;
  private epoch = 0;
  private waiters: ((ok: boolean) => void)[] = [];
  private status: SaveStatus = { kind: "idle" };
  private options: DocumentSaverOptions | null = null;
  private readonly emit: (view: DocumentSaverView) => void;

  constructor(emit: (view: DocumentSaverView) => void) {
    this.emit = emit;
  }

  setOptions = (options: DocumentSaverOptions): void => {
    this.options = options;
  };

  /** Открыт документ (или закрыт — `null`): снимок и revision — его. */
  reset = (document: ApiDocument | null): void => {
    this.epoch += 1;
    this.clearTimer();
    this.id = document?.id ?? null;
    this.revision = document?.revision ?? 0;
    this.saved = document?.text ?? "";
    this.text = this.saved;
    this.busy = false;
    this.conflict = false;
    this.failed = null;
    this.settle(false);
    this.status = { kind: "idle" };
    this.publish();
  };

  edit = (text: string): void => {
    this.text = text;
    this.clearTimer();
    if (!this.conflict) {
      this.timer = window.setTimeout(() => {
        this.timer = null;
        this.pump();
      }, SAVE_DELAY);
    }
    this.publish();
  };

  retry = (): void => {
    this.failed = null;
    this.pump();
  };

  /** Записать ожидающее сразу и дождаться; `true` — всё сохранено. */
  flush = (): Promise<boolean> => {
    this.clearTimer();
    if (this.conflict) return Promise.resolve(false);
    if (!this.busy && this.text === this.saved) return Promise.resolve(true);
    if (!this.busy && this.failed === this.text) return Promise.resolve(false);
    const promise = new Promise<boolean>((resolve) => {
      this.waiters.push(resolve);
    });
    this.pump();
    return promise;
  };

  dispose = (): void => {
    this.clearTimer();
  };

  private clearTimer(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  private publish(): void {
    this.emit({ status: this.status, unsaved: this.busy || this.text !== this.saved });
  }

  private settle(ok: boolean): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve(ok);
  }

  private pump(): void {
    if (this.busy || this.conflict || this.id === null) return;
    if (this.text === this.saved) {
      if (this.failed === null) {
        this.status = { kind: "idle" };
        this.settle(true);
      }
      this.publish();
      return;
    }
    if (this.failed === this.text) {
      this.publish();
      return;
    }
    this.failed = null;
    this.busy = true;
    this.status = { kind: "saving" };
    this.publish();
    const { id, text, epoch } = this;
    const options = this.options;
    if (options === null) throw new Error("DocumentSaver: не заданы options");
    options.writeText(id, { revision: this.revision, text }).then(
      (result) => {
        if (epoch !== this.epoch) return;
        this.busy = false;
        this.revision = result.revision;
        this.saved = text;
        options.onSaved(result);
        this.pump();
      },
      (error: unknown) => {
        if (epoch !== this.epoch) return;
        this.busy = false;
        if (error instanceof ApiError && error.code === "document_conflict") {
          this.conflict = true;
          this.clearTimer();
          this.status = { kind: "conflict" };
        } else {
          this.failed = text;
          this.status = { kind: "error", message: userMessage(error) };
        }
        this.settle(false);
        this.publish();
      },
    );
  }
}

/** Хук над `DocumentSaver`: состояние для рендера и стабильные методы. */
export function useDocumentSaver(options: DocumentSaverOptions) {
  const [view, setView] = useState<DocumentSaverView>({ status: { kind: "idle" }, unsaved: false });
  const [saver] = useState(() => {
    const created = new DocumentSaver(setView);
    // опции нужны уже первому reset/edit, до эффекта
    created.setOptions(options);
    return created;
  });
  useEffect(() => {
    saver.setOptions(options);
  });
  useEffect(() => saver.dispose, [saver]);
  return {
    ...view,
    edit: saver.edit,
    reset: saver.reset,
    retry: saver.retry,
    flush: saver.flush,
  };
}
