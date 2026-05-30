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

export interface PetState {
  mode: PetMode;
  message: string;
}

export type PetEvent =
  | { type: "WAKE" }
  | { type: "REST" }
  | { type: "LISTEN" }
  | { type: "CHAT_SUBMITTED" }
  | { type: "CHAT_STREAM_STARTED" }
  | { type: "CHAT_COMPLETED" }
  | { type: "FAILED"; message: string };

export const initialPetState: PetState = {
  mode: "idle",
  message: "Piko 正在桌面上陪着你。",
};

export function reducePetState(state: PetState, event: PetEvent): PetState {
  switch (event.type) {
    case "WAKE":
      return { mode: "idle", message: "Piko 已经醒来。" };
    case "REST":
      return { mode: "resting", message: "Piko 正在安静休息。" };
    case "LISTEN":
      return { mode: "listening", message: "Piko 正在等你说话。" };
    case "CHAT_SUBMITTED":
      return { mode: "thinking", message: "Piko 正在思考。" };
    case "CHAT_STREAM_STARTED":
      return { mode: "speaking", message: "Piko 正在回复。" };
    case "CHAT_COMPLETED":
      return { mode: "idle", message: "Piko 正在桌面上陪着你。" };
    case "FAILED":
      return { mode: "error", message: event.message };
    default:
      return state;
  }
}

