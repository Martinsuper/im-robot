export type PetMode =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "working"
  | "success"
  | "confirming"
  | "resting"
  | "error";

export type PetEmotion =
  | "neutral"
  | "happy"
  | "curious"
  | "sleepy"
  | "surprised"
  | "worried";

export type PetReaction = "none" | "greet" | "notice" | "celebrate";

export interface PetState {
  mode: PetMode;
  message: string;
  emotion: PetEmotion;
  reaction: PetReaction;
}

export type PetEvent =
  | { type: "WAKE" }
  | { type: "REST" }
  | { type: "LISTEN" }
  | { type: "INTERACT" }
  | { type: "ATTACHMENT_READY" }
  | { type: "WORK_STARTED" }
  | { type: "REMINDER_FIRED"; message: string }
  | { type: "CHAT_SUBMITTED" }
  | { type: "CHAT_STREAM_STARTED" }
  | { type: "CHAT_COMPLETED" }
  | { type: "RESET" }
  | { type: "FAILED"; message: string };

export const initialPetState: PetState = {
  mode: "idle",
  message: "Piko 正在桌面上陪着你。",
  emotion: "neutral",
  reaction: "none",
};

export function reducePetState(state: PetState, event: PetEvent): PetState {
  switch (event.type) {
    case "WAKE":
      return { mode: "idle", message: "Piko 已经醒来。", emotion: "happy", reaction: "greet" };
    case "REST":
      return { mode: "resting", message: "Piko 正在安静休息。", emotion: "sleepy", reaction: "none" };
    case "LISTEN":
      return { mode: "listening", message: "Piko 正在等你说话。", emotion: "curious", reaction: "notice" };
    case "INTERACT":
      return { mode: "idle", message: "Piko 注意到你了。", emotion: "happy", reaction: "greet" };
    case "ATTACHMENT_READY":
      return { mode: "confirming", message: "Piko 已收到文件，等你选择处理方式。", emotion: "curious", reaction: "notice" };
    case "WORK_STARTED":
      return { mode: "working", message: "Piko 正在处理文件。", emotion: "curious", reaction: "notice" };
    case "REMINDER_FIRED":
      return { mode: "success", message: event.message, emotion: "surprised", reaction: "notice" };
    case "CHAT_SUBMITTED":
      return { mode: "thinking", message: "Piko 正在思考。", emotion: "curious", reaction: "none" };
    case "CHAT_STREAM_STARTED":
      return { mode: "speaking", message: "Piko 正在回复。", emotion: "neutral", reaction: "none" };
    case "CHAT_COMPLETED":
      return { mode: "success", message: "Piko 完成啦。", emotion: "happy", reaction: "celebrate" };
    case "RESET":
      return initialPetState;
    case "FAILED":
      return { mode: "error", message: event.message, emotion: "worried", reaction: "notice" };
    default:
      return state;
  }
}
