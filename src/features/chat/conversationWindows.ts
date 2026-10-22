import { isTauriRuntime, runCommand } from "../app/appRuntime";
export type ConversationWindow = { conversationId: string; title: string; width: number; height: number; x?: number | null; y?: number | null };
export type WindowSnapshot = { revision: number; windows: ConversationWindow[] };
export const PREVIEW_WINDOWS_KEY = "piko.preview.conversation-windows";
export function previewWindows(): WindowSnapshot {
  try { return JSON.parse(localStorage.getItem(PREVIEW_WINDOWS_KEY) || "null") || { revision: 0, windows: [] }; }
  catch { return { revision: 0, windows: [] }; }
}
export async function openConversationWindow(id: string, title: string): Promise<WindowSnapshot> {
  if (isTauriRuntime) return await runCommand("conversation_open_window", { conversationId: id, title });
  const url = new URL(location.href);
  url.search = new URLSearchParams({ view: "bubble", conversation: id }).toString();
  const popup = window.open(url, `conversation-${id}`, "popup,width=760,height=760");
  if (!popup) throw new Error("浏览器阻止了弹出窗口，请允许后重试。");
  const current = previewWindows();
  const result = { revision: current.revision + 1, windows: [...current.windows.filter(item => item.conversationId !== id), { conversationId: id, title, width: 760, height: 760 }] };
  localStorage.setItem(PREVIEW_WINDOWS_KEY, JSON.stringify(result));
  popup.focus();
  return result;
}
export async function closeConversationWindow(id: string): Promise<void> {
  if (isTauriRuntime) { await runCommand("conversation_close_window", { conversationId: id }); return; }
  const current = previewWindows();
  localStorage.setItem(PREVIEW_WINDOWS_KEY, JSON.stringify({ revision: current.revision + 1, windows: current.windows.filter(item => item.conversationId !== id) }));
  if (new URLSearchParams(location.search).get("conversation") === id) window.close();
}
