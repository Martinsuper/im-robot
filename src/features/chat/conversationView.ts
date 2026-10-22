import type { AttachmentAction, AttachmentPreview, ScreenshotPreview, ChatHistoryEntry } from "../../types/appTypes";
import { isTauriRuntime, runCommand } from "../app/appRuntime";

export type ConversationView = {
  revision?: number;
  prompt: string;
  cwd: string;
  knowledgeScope?: string | null;
  attachmentAction: AttachmentAction;
  attachment?: AttachmentPreview | null;
  screenshot?: ScreenshotPreview | null;
  previewTurn?: { history: ChatHistoryEntry[]; prompt: string; response: string; requestId?: string; thinking: boolean; status: "done" | "failed" | "cancelled" | null };
};
const key = (id: string) => `piko.conversation.view:${id}`;
export async function loadConversationView(id: string): Promise<ConversationView | null> {
  if (isTauriRuntime) return await runCommand("conversation_get_view", { conversationId: id }) as ConversationView | null;
  try { return JSON.parse(localStorage.getItem(key(id)) || "null"); } catch { return null; }
}
export async function saveConversationView(id: string, view: ConversationView): Promise<void> {
  if (isTauriRuntime) { await runCommand("conversation_save_view", { conversationId: id, view: { ...view, revision: view.revision ?? 0, knowledgeScope: view.knowledgeScope ?? null, attachment: view.attachment ?? null, screenshot: view.screenshot ?? null } }); return; }
  localStorage.setItem(key(id), JSON.stringify(view));
}
