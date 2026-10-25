import type { TaskRecord } from "./TaskHistory";

export function deviceConversations(records: TaskRecord[], history: { id: string; prompt: string }[]) {
  const prompts = new Map(history.map(entry => [entry.id, entry.prompt]));
  const seen = new Set<string>();
  return [...records].sort((a, b) => b.updatedAt - a.updatedAt).flatMap(record => {
    if (!/^passport-[a-f0-9]{24}$/.test(record.conversationId) || seen.has(record.conversationId)) return [];
    seen.add(record.conversationId);
    return [{ id: record.conversationId, title: prompts.get(record.requestId)?.slice(0, 24) || "设备对话" }];
  });
}
