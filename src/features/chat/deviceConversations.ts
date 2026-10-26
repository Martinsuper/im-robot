import type { TaskRecord } from "./TaskHistory";

export type RecentConversation = { id: string; title: string };
type History = { id: string; prompt: string; createdAt: number; conversationId?: string | null };
const isDevice = (id: string) => /^passport-[a-f0-9]{24}$/.test(id);

export function deviceConversations(records: TaskRecord[], history: History[]): RecentConversation[] {
  const prompts = new Map(history.map(entry => [entry.id, entry.prompt]));
  const candidates = [
    ...history.filter(entry => entry.conversationId && isDevice(entry.conversationId)).map(entry => ({
      id: entry.conversationId!, title: entry.prompt.slice(0, 24) || "设备对话", at: entry.createdAt,
    })),
    ...records.filter(record => isDevice(record.conversationId) && (record.status !== "completed" || prompts.has(record.requestId))).map(record => ({
      id: record.conversationId, title: prompts.get(record.requestId)?.slice(0, 24) || "设备对话", at: record.updatedAt,
    })),
  ];
  const seen = new Set<string>();
  return candidates.sort((a, b) => b.at - a.at).flatMap(({ id, title }) => {
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ id, title }];
  });
}
