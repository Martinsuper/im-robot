import type { ChatHistoryEntry } from "../../types/appTypes";
import { type ChatTimeRange } from "./recordsSearch";

export const chatTimeRangeOptions: Array<{ label: string; value: ChatTimeRange | "all" }> = [
  { label: "全部", value: "all" },
  { label: "今天", value: "today" },
  { label: "本周", value: "week" },
  { label: "更早", value: "earlier" },
];


export function formatChatHistoryTime(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp * 1000);
}


export interface PanelHistoryProps {
  chatHistory: ChatHistoryEntry[];
  /** 清除全部历史。仍由调用方持有命令与刷新逻辑，这里只负责触发。 */
  onClear: () => Promise<void>;
}
