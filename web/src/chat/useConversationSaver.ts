/**
 * Очередь сохранения диалога: записи строго по одной, каждая считается от последнего
 * успешно сохранённого снимка (`planWrite`), поэтому после сбоя одна запись догоняет всё.
 *
 * Логика — в классе `ConversationSaver` (без React); хук только отражает его состояние.
 */

import { useEffect, useState } from "react";
import type { createConversation, patchConversation, replaceTail } from "../api/conversations";
import { ApiError, userMessage } from "../api/errors";
import type { ApiChatSettings, ApiMessage, Conversation } from "../api/types";
import { hasUnsaved, planWrite, titleFrom, type WritePlan } from "./persist";
import type { ChatMessage } from "./state";

export type SaveStatus =
  { kind: "idle" } | { kind: "saving" } | { kind: "error"; message: string } | { kind: "conflict" };

export interface SaverApi {
  createConversation: typeof createConversation;
  replaceTail: typeof replaceTail;
  patchConversation: typeof patchConversation;
}

export interface SaverOptions {
  api: SaverApi;
  /** Создан новый диалог: адрес и боковая панель. */
  onCreated: (conversation: Conversation) => void;
  /** Записаны сообщения существующего диалога: поднять его в панели. */
  onSaved: (meta: { id: string; updated_at: string }) => void;
}

export interface SaverView {
  status: SaveStatus;
  conversationId: string | null;
  /** Есть несохранённое или запись в полёте. */
  unsaved: boolean;
}

const SETTINGS_DELAY = 500;

type Work =
  | { kind: "create"; plan: WritePlan; settings: ApiChatSettings }
  | { kind: "tail"; id: string; plan: WritePlan }
  | { kind: "settings"; id: string; settings: ApiChatSettings };

export class ConversationSaver {
  private id: string | null = null;
  private revision = 0;
  private saved: ApiMessage[] = [];
  // null — после reset экран ещё не сообщил сообщения: писать их нечего
  private messages: ChatMessage[] | null = null;
  private settings: ApiChatSettings | null = null;
  private savedSettings: string | null = null;
  private settingsDue = false;
  private settingsTimer: number | null = null;
  private busy = false;
  private conflict = false;
  // упавшая запись повторяется только по retry() или когда план изменился (не на каждую дельту)
  private failedKey: string | null = null;
  private epoch = 0;
  private waiters: ((ok: boolean) => void)[] = [];
  private status: SaveStatus = { kind: "idle" };
  private options: SaverOptions | null = null;
  private readonly emit: (view: SaverView) => void;

  constructor(emit: (view: SaverView) => void) {
    this.emit = emit;
  }

  /** API и колбэки — из последнего рендера (хук обновляет их в эффекте). */
  setOptions = (options: SaverOptions): void => {
    this.options = options;
  };

  /** Текущее состояние экрана; запись запускается, если есть что сохранять. */
  sync = (messages: ChatMessage[], settings: ApiChatSettings): void => {
    this.messages = messages;
    this.settings = settings;
    this.pump();
  };

  /** Изменение настроек: PATCH через 500 мс после последней правки (у нового — после POST). */
  syncSettings = (settings: ApiChatSettings): void => {
    this.settings = settings;
    this.clearTimer();
    this.settingsTimer = window.setTimeout(() => {
      this.settingsTimer = null;
      this.settingsDue = true;
      this.pump();
    }, SETTINGS_DELAY);
  };

  /** Открыт сохранённый диалог (или новый — `null`): снимок и revision — его. */
  reset = (conversation: Conversation | null): void => {
    this.epoch += 1;
    this.clearTimer();
    this.id = conversation?.id ?? null;
    this.revision = conversation?.revision ?? 0;
    this.saved = conversation?.messages ?? [];
    this.savedSettings = conversation === null ? null : JSON.stringify(conversation.settings);
    this.settingsDue = false;
    this.messages = null;
    this.busy = false;
    this.conflict = false;
    this.failedKey = null;
    this.settle(false);
    this.status = { kind: "idle" };
    this.publish();
  };

  retry = (): void => {
    this.failedKey = null;
    this.pump();
  };

  /** Дождаться опустошения очереди; `true` — всё сохранено. */
  flush = (): Promise<boolean> => {
    if (this.conflict) return Promise.resolve(false);
    if (this.settingsTimer !== null) {
      this.clearTimer();
      this.settingsDue = true;
    }
    if (!this.busy && this.failedKey !== null) {
      const work = this.nextWork();
      if (work !== null && JSON.stringify(work) === this.failedKey) return Promise.resolve(false);
    }
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
    if (this.settingsTimer !== null) window.clearTimeout(this.settingsTimer);
    this.settingsTimer = null;
  }

  private publish(): void {
    const unsaved = this.busy || (this.messages !== null && hasUnsaved(this.saved, this.messages));
    this.emit({ status: this.status, conversationId: this.id, unsaved });
  }

  private settle(ok: boolean): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve(ok);
  }

  private nextWork(): Work | null {
    const { messages, settings, id } = this;
    if (settings === null) return null;
    if (id === null) {
      const plan = messages === null ? null : planWrite([], messages);
      return plan === null ? null : { kind: "create", plan, settings };
    }
    const plan = messages === null ? null : planWrite(this.saved, messages);
    if (plan !== null) return { kind: "tail", id, plan };
    if (this.settingsDue && JSON.stringify(settings) !== this.savedSettings) {
      return { kind: "settings", id, settings };
    }
    return null;
  }

  private pump(): void {
    if (this.busy || this.conflict) return;
    const work = this.nextWork();
    if (work === null) {
      if (this.failedKey === null) {
        this.status = { kind: "idle" };
        this.settle(true);
      }
      this.publish();
      return;
    }
    const key = JSON.stringify(work);
    if (this.failedKey === key) {
      this.publish();
      return;
    }
    this.failedKey = null;
    this.busy = true;
    this.status = { kind: "saving" };
    this.publish();
    const epoch = this.epoch;
    this.run(work, epoch).then(
      () => {
        if (epoch !== this.epoch) return;
        this.busy = false;
        this.pump();
      },
      (error: unknown) => {
        if (epoch !== this.epoch) return;
        this.busy = false;
        if (error instanceof ApiError && error.code === "conversation_conflict") {
          this.conflict = true;
          this.status = { kind: "conflict" };
        } else {
          this.failedKey = key;
          this.status = { kind: "error", message: userMessage(error) };
        }
        this.settle(false);
        this.publish();
      },
    );
  }

  private async run(work: Work, epoch: number): Promise<void> {
    if (this.options === null) throw new Error("ConversationSaver: не заданы options");
    const { api, onCreated, onSaved } = this.options;
    switch (work.kind) {
      case "create": {
        const first = work.plan.messages.find((m) => m.role === "user");
        const title =
          first?.role === "user"
            ? titleFrom(first.text, first.images.length > 0)
            : titleFrom("", false);
        const created = await api.createConversation({
          title,
          settings: work.settings,
          messages: work.plan.messages,
        });
        if (epoch !== this.epoch) return;
        this.id = created.id;
        this.revision = created.revision;
        this.saved = work.plan.messages;
        this.savedSettings = JSON.stringify(work.settings);
        onCreated(created);
        return;
      }
      case "tail": {
        const result = await api.replaceTail(work.id, work.plan.from, {
          revision: this.revision,
          messages: work.plan.messages,
        });
        if (epoch !== this.epoch) return;
        this.revision = result.revision;
        this.saved = [...this.saved.slice(0, work.plan.from), ...work.plan.messages];
        onSaved({ id: work.id, updated_at: result.updated_at });
        return;
      }
      case "settings": {
        await api.patchConversation(work.id, { settings: work.settings });
        if (epoch !== this.epoch) return;
        this.savedSettings = JSON.stringify(work.settings);
        this.settingsDue = false;
        return;
      }
    }
  }
}

/** Хук над `ConversationSaver`: состояние для рендера и стабильные методы. */
export function useConversationSaver(options: SaverOptions) {
  const [view, setView] = useState<SaverView>({
    status: { kind: "idle" },
    conversationId: null,
    unsaved: false,
  });
  const [saver] = useState(() => new ConversationSaver(setView));
  useEffect(() => {
    saver.setOptions(options);
  });
  useEffect(() => saver.dispose, [saver]);
  return {
    ...view,
    sync: saver.sync,
    syncSettings: saver.syncSettings,
    reset: saver.reset,
    retry: saver.retry,
    flush: saver.flush,
  };
}
