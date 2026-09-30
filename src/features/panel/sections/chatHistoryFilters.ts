import type { ChatHistoryEntry } from "../../../types/appTypes";

export type ChatHistoryFilter = "all" | "attachment" | "screenshot" | "code" | "link" | "long";

export const chatHistoryFilterOptions: Array<{ label: string; value: ChatHistoryFilter }> = [
  { label: "全部", value: "all" },
  { label: "附件", value: "attachment" },
  { label: "截图", value: "screenshot" },
  { label: "代码", value: "code" },
  { label: "链接", value: "link" },
  { label: "长回复", value: "long" },
];

export function getChatHistoryTags(entry: ChatHistoryEntry): ChatHistoryFilter[] {
  const text = `${entry.prompt}\n${entry.response}`;
  const tags: ChatHistoryFilter[] = [];

  if (entry.prompt.includes("[附件")) tags.push("attachment");
  if (entry.prompt.includes("[截图")) tags.push("screenshot");
  if (/```|<\/?[a-z][\s\S]*>/i.test(text)) tags.push("code");
  if (/https?:\/\//i.test(text)) tags.push("link");
  if (entry.response.length > 600) tags.push("long");

  return tags;
}

export function chatHistoryFilterLabel(filter: ChatHistoryFilter) {
  return chatHistoryFilterOptions.find((option) => option.value === filter)?.label ?? filter;
}

export function formatChatHistoryTime(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp * 1000);
}

export function summarizeChatText(text: string, fallback: string) {
  const normalized = text.replace(/\s+/g, " ").trim() || fallback;
  return normalized.length > 140 ? `${normalized.slice(0, 140)}...` : normalized;
}

export function chatHistoryMatchesSearch(entry: ChatHistoryEntry, search: string) {
  const keyword = search.trim().toLocaleLowerCase();
  if (!keyword) return true;

  return `${entry.prompt}\n${entry.response}`.toLocaleLowerCase().includes(keyword);
}
