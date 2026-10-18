// S08: proactive message identity shared by the bubble and any notification.
// Responses go into the ordinary chat input and never auto-run tools.
import { ActivitySnapshot, MessageReceipt, ProactiveCategory, SourceRef } from "./types";
import { isTauriRuntime, runCommandQuiet } from "../app/appRuntime";

export interface SoulProactiveMessage {
  id: string;
  category: ProactiveCategory;
  templateId: string;
  text: string;
  source: SourceRef;
}

export function reportSoulActivity(snapshot: ActivitySnapshot): void {
  if (!isTauriRuntime) return;
  runCommandQuiet("soul_report_activity", { snapshot });
}

function acknowledge(receipt: MessageReceipt): void {
  if (!isTauriRuntime) return;
  runCommandQuiet("soul_ack_message", { receipt });
}

export function ackShown(messageId: string): void {
  acknowledge({ message_id: messageId, kind: "shown", visible_seconds: 0 });
}

export function ackHidden(messageId: string): void {
  // The backend measures visibility with its own monotonic clock; the UI
  // number is advisory only and never used as ignore evidence.
  acknowledge({ message_id: messageId, kind: "hidden", visible_seconds: 0 });
}

export function ackResponded(messageId: string): void {
  acknowledge({ message_id: messageId, kind: "responded", visible_seconds: 0 });
}

export function ackDismissed(messageId: string): void {
  acknowledge({ message_id: messageId, kind: "dismissed", visible_seconds: 0 });
}

/** Ten-seconds cadence is the dispatcher heartbeat; 5s gives margin. */
export const ACTIVITY_HEARTBEAT_SECONDS = 5;

/**
 * Heartbeat the backend needs every few seconds; every field is optional so
 * unknown states stay conservative on the backend side.
 */
export function currentActivitySnapshot(typing: boolean): ActivitySnapshot {
  return {
    observed_at: Math.floor(Date.now() / 1000),
    locked: null,
    idle: null,
    typing,
    agent_busy: null,
    awaiting_confirmation: null,
    pet_visible: null,
    quiet_mode: null,
  };
}

export const SOUL_CATEGORY_LABELS: Record<ProactiveCategory, string> = {
  task_unresolved: "任务跟进",
  open_loop: "话题回访",
  greeting: "打了个招呼",
  milestone: "小小庆祝",
  pattern: "有个观察",
  small_talk: "想聊聊",
  output_feedback: "想聊聊你的产出",
};

export interface SoulReplyContext { message_id: string; source: SourceRef; verification_of: string | null }
