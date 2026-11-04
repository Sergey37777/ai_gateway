/** Состояние чата: сообщения, текущий стрим, правка и перегенерация. Истории между сессиями нет. */

export interface ImageAttachment {
  name: string;
  dataUrl: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface UserMessage {
  id: number;
  role: "user";
  text: string;
  images: ImageAttachment[];
}

export interface AssistantMessage {
  id: number;
  role: "assistant";
  content: string;
  reasoning: string;
  status: "streaming" | "done" | "stopped" | "error";
  usage: Usage | null;
  error: string | null;
}

export type ChatMessage = UserMessage | AssistantMessage;

export interface ChatState {
  messages: ChatMessage[];
  nextId: number;
  /** id ответа, который сейчас стримится. */
  streamingId: number | null;
  /** id ответа, для которого компонент должен начать запрос (сбрасывается `started`). */
  pending: number | null;
}

export type ChatAction =
  | { type: "send"; text: string; images: ImageAttachment[] }
  | { type: "started"; id: number }
  | { type: "delta"; id: number; content?: string; reasoning?: string }
  | { type: "usage"; id: number; usage: Usage }
  | { type: "finish"; id: number }
  | { type: "fail"; id: number; message: string }
  | { type: "stop"; id: number }
  | { type: "edit"; id: number; text: string }
  | { type: "regenerate" }
  | { type: "clear" };

export const initialChatState: ChatState = {
  messages: [],
  nextId: 0,
  streamingId: null,
  pending: null,
};

function withNewAnswer(state: ChatState, messages: ChatMessage[]): ChatState {
  const id = state.nextId;
  const answer: AssistantMessage = {
    id,
    role: "assistant",
    content: "",
    reasoning: "",
    status: "streaming",
    usage: null,
    error: null,
  };
  return { messages: [...messages, answer], nextId: id + 1, streamingId: id, pending: id };
}

function updateAnswer(
  state: ChatState,
  id: number,
  update: (message: AssistantMessage) => AssistantMessage,
  finished: boolean,
): ChatState {
  // события не текущего стрима (после stop/clear/regenerate) — запоздавшие, игнорируем
  if (id !== state.streamingId) return state;
  return {
    ...state,
    messages: state.messages.map((m) => (m.id === id && m.role === "assistant" ? update(m) : m)),
    ...(finished && { streamingId: null, pending: null }),
  };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "send": {
      if (state.streamingId !== null) return state;
      const question: UserMessage = {
        id: state.nextId,
        role: "user",
        text: action.text,
        images: action.images,
      };
      return withNewAnswer({ ...state, nextId: state.nextId + 1 }, [...state.messages, question]);
    }
    case "started":
      return action.id === state.pending ? { ...state, pending: null } : state;
    case "delta":
      return updateAnswer(
        state,
        action.id,
        (m) => ({
          ...m,
          content: m.content + (action.content ?? ""),
          reasoning: m.reasoning + (action.reasoning ?? ""),
        }),
        false,
      );
    case "usage":
      return updateAnswer(state, action.id, (m) => ({ ...m, usage: action.usage }), false);
    case "finish":
      return updateAnswer(state, action.id, (m) => ({ ...m, status: "done" }), true);
    case "fail":
      return updateAnswer(
        state,
        action.id,
        (m) => ({ ...m, status: "error", error: action.message }),
        true,
      );
    case "stop":
      return updateAnswer(state, action.id, (m) => ({ ...m, status: "stopped" }), true);
    case "edit": {
      if (state.streamingId !== null) return state;
      const index = state.messages.findIndex((m) => m.id === action.id && m.role === "user");
      const original = state.messages[index];
      if (original?.role !== "user") return state;
      const edited: UserMessage = { ...original, text: action.text };
      return withNewAnswer(state, [...state.messages.slice(0, index), edited]);
    }
    case "regenerate": {
      if (state.streamingId !== null) return state;
      const lastMessage = state.messages.at(-1);
      if (lastMessage?.role !== "assistant") return state;
      return withNewAnswer(state, state.messages.slice(0, -1));
    }
    case "clear":
      // nextId сохраняется: id не повторяются, запоздавшие события старого диалога не совпадут
      return { ...initialChatState, nextId: state.nextId };
  }
}

/** Сообщения до ответа `assistantId` — история для запроса. */
export function historyBefore(state: ChatState, assistantId: number): ChatMessage[] {
  const index = state.messages.findIndex((m) => m.id === assistantId);
  return index < 0 ? state.messages : state.messages.slice(0, index);
}
