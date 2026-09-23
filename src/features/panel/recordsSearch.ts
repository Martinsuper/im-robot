/**
 * 「记录」Tab 的搜索与展示辅助函数（04 §4）。
 *
 * 全部是纯函数，所以可以单测：跨三处内容（备忘 / Piko 记住的 / 对话历史）
 * 的匹配规则一旦散落在组件里，就没人说得清「为什么这条搜不到」。
 */

import type { ChatHistoryEntry, Memo } from "../../types/appTypes";
import type { MemoryItem } from "../memory/memoryTypes";

/** 搜索框防抖时长（毫秒）。 */
export const RECORD_SEARCH_DEBOUNCE_MS = 300;

/** 每个来源最多展示几条。 */
export const SEARCH_RESULT_LIMIT = 8;

/** 卡片 / 摘要截断长度。 */
const SUMMARY_MAX_CHARS = 120;

/** 对话历史的时间桶。 */
export type ChatTimeRange = "today" | "week" | "earlier";

// --- 匹配字段（04 §4：分别匹配哪些字段） ---

/** 我的记录：标题 + 摘要 + 正文 + 标签。 */
export function memoSearchFields(memo: Memo): string {
  return [memo.title, memo.summary, memo.content, memo.tags.join(" ")].join("\n");
}

/** Piko 记住的：标题 + 内容 + 标签。技术字段（类型 / 置信度 / 来源枚举）不参与。 */
export function memorySearchFields(memory: MemoryItem): string {
  return [memory.title, memory.content, memory.tags.join(" ")].join("\n");
}

/** 对话历史：一轮问答的提问 + 回答（即 ChatHistoryEntry.prompt / response）。 */
export function chatSearchFields(entry: ChatHistoryEntry): string {
  return [entry.prompt, entry.response].join("\n");
}

/**
 * 关键词包含匹配。
 *
 * 空关键词返回 false：调用方只在真的有关键词时才过滤，
 * 这样「忘记判空」不会退化成「全部命中」。
 */
export function containsKeyword(haystack: string, keyword: string): boolean {
  const needle = keyword.trim().toLocaleLowerCase();
  if (!needle) return false;
  return haystack.toLocaleLowerCase().includes(needle);
}

// --- 展示 ---

/** 压平成一行并截断，用于卡片正文与搜索结果摘要。 */
export function summarizeText(text: string, maxChars: number = SUMMARY_MAX_CHARS): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}…` : normalized;
}

// --- 对话历史的时间筛选（今天 / 本周 / 更早） ---

/**
 * 自然日差值分桶。
 *
 * 「本周」取最近 7 天（含今天之前 6 天），而不是日历周：对话是流水的，
 * 用户点「本周」想看的是「这几天」，周一早上发现自己昨天聊的都算「更早」会更困惑。
 */
export function chatTimeBucket(atSeconds: number, referenceSeconds: number): ChatTimeRange {
  const dayMs = 24 * 60 * 60 * 1000;
  const startOfDay = (at: number) => {
    const date = new Date(at * 1000);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };
  const offset = Math.round((startOfDay(atSeconds) - startOfDay(referenceSeconds)) / dayMs);
  if (offset === 0) return "today";
  if (offset >= -6) return "week";
  return "earlier";
}
