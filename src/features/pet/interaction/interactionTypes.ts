import type { PetEmotion, EmotionEvent } from "../emotion";
import type { PetEvent } from "../petState";
import type { QuietMode } from "../../../types/appTypes";

export type HumanInteractionType =
  | "click"
  | "double_click"
  | "hover"
  | "hover_leave"
  | "long_press"
  | "drag_start"
  | "drag_move"
  | "drag_end"
  | "drop_file"
  | "drop_text"
  | "pet_stroke"
  | "chat_open"
  | "chat_submitted"
  | "chat_completed"
  | "user_idle_started"
  | "user_idle_ended"
  | "focus_started"
  | "focus_completed"
  | "ambient_nudge"
  | "break_reminder"
  | "FAILED";

export interface HumanInteractionEvent {
  type: HumanInteractionType;
  timestamp: number;
  intensity?: number;
  payload?: {
    durationMs?: number;
    distancePx?: number;
    fileCount?: number;
    fileName?: string;
    fileSize?: number;
    message?: string;
  };
}

export interface InteractionContext {
  quietMode: QuietMode;
  petMode: string;
  petEmotion: string;
  isResting: boolean;
  recentInteractionCount: number;
  lastInteractionAt?: number;
  intimacy: number;
  energy: number;
}

export interface PetInteractionResult {
  petEvent?: PetEvent;
  emotion?: PetEmotion;
  sound?: "click" | "greet" | "curious" | "celebrate" | "notice" | "error" | "wake" | "drop";
  openBubble?: boolean;
  openPanel?: boolean;
  saveStats?: boolean;
  event?: EmotionEvent;
}

export interface InteractionStats {
  totalInteractions: number;
  clickCount: number;
  doubleClickCount: number;
  hoverCount: number;
  petStrokeCount: number;
  dragCount: number;
  dropCount: number;
  chatCount: number;
  focusCount: number;
  intimacy: number;
  lastInteractionAt: number | null;
}

export const DEFAULT_INTERACTION_STATS: InteractionStats = {
  totalInteractions: 0,
  clickCount: 0,
  doubleClickCount: 0,
  hoverCount: 0,
  petStrokeCount: 0,
  dragCount: 0,
  dropCount: 0,
  chatCount: 0,
  focusCount: 0,
  intimacy: 0,
  lastInteractionAt: null,
};
