import { useMemo, useState } from "react";
import type { ChatHistoryEntry } from "../../types/appTypes";
import { EmptyState } from "../../components/feedback/States";
import { chatTimeBucket, containsKeyword, summarizeText, type ChatTimeRange } from "./recordsSearch";
import { nowSeconds } from "./time";

/** 时间筛选：今天 / 本周 / 更早 / 全部。 */
const chatTimeRangeOptions: Array<{ label: string; value: ChatTimeRange | "all" }> = [
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

/**
 * 对话历史（04 §3.4）。
 *
 * 现状的「附件 / 截图 / 代码 / 链接 / 长回复」过滤标签已移除：它们靠字符串
 * 匹配 prompt，既不稳定也对用户没价值，换成「搜索 + 时间筛选」。
 * 今日专注也不再展示——它已经搬到「今天」Tab。
 */
export function PanelHistory({ chatHistory, onClear }: PanelHistoryProps) {
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [historyRange, setHistoryRange] = useState<ChatTimeRange | "all">("all");
  const [historySearch, setHistorySearch] = useState("");

  const filteredChatHistory = useMemo(() => {
    // 时间基准取一次（和「今天」Tab 一样用 time.ts 的 nowSeconds）。
    // 代价：过了自然日分界不会自动重算，切一次筛选或搜索即可刷新——
    // 比把它做成每秒跳变的 state 更安静。
    const reference = nowSeconds();
    return chatHistory.filter((entry) => {
      if (historyRange !== "all" && chatTimeBucket(entry.createdAt, reference) !== historyRange) {
        return false;
      }
      return historySearch.trim()
        ? containsKeyword(`${entry.prompt}\n${entry.response}`, historySearch)
        : true;
    });
  }, [chatHistory, historyRange, historySearch]);

  const selectedHistoryEntry = useMemo(() => {
    if (!filteredChatHistory.length) return undefined;
    return filteredChatHistory.find((entry) => entry.id === selectedHistoryId) ?? filteredChatHistory[0];
  }, [filteredChatHistory, selectedHistoryId]);

  return (
    <section className="panel-card records-history" aria-label="对话历史">
      <div className="section-heading">
        <div>
          <p className="eyebrow">CHAT HISTORY</p>
          <h2>最近对话</h2>
        </div>
        <button type="button" disabled={!chatHistory.length} onClick={() => void onClear()}>
          清除历史
        </button>
      </div>

      {chatHistory.length ? (
        <>
          <div className="records-history__search">
            <input
              value={historySearch}
              onChange={(event) => setHistorySearch(event.currentTarget.value)}
              placeholder="搜索历史对话"
              aria-label="搜索历史对话"
            />
            {historySearch.trim() && (
              <button type="button" onClick={() => setHistorySearch("")}>
                清空
              </button>
            )}
          </div>

          <div className="segmented-control records-history__range" role="group" aria-label="对话时间筛选">
            {chatTimeRangeOptions.map((option) => (
              <button
                className={historyRange === option.value ? "is-active" : ""}
                key={option.value}
                type="button"
                onClick={() => setHistoryRange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>

          {filteredChatHistory.length ? (
            <div className="records-history__layout">
              <ul className="records-history__list" aria-label="最近对话列表">
                {filteredChatHistory.map((entry) => (
                  <li className={entry.id === selectedHistoryEntry?.id ? "is-active" : ""} key={entry.id}>
                    <button type="button" onClick={() => setSelectedHistoryId(entry.id)}>
                      <span className="records-history__time">{formatChatHistoryTime(entry.createdAt)}</span>
                      <strong>{summarizeText(entry.prompt, 60) || "未命名对话"}</strong>
                      <span>{summarizeText(entry.response, 80) || "没有返回文本"}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {selectedHistoryEntry && (
                <article className="records-history__detail">
                  <div className="records-history__meta">
                    <span>{formatChatHistoryTime(selectedHistoryEntry.createdAt)}</span>
                    <span>{selectedHistoryEntry.response.length.toLocaleString("zh-CN")} 字</span>
                  </div>
                  <div>
                    <p className="eyebrow">PROMPT</p>
                    <p>{selectedHistoryEntry.prompt}</p>
                  </div>
                  <div>
                    <p className="eyebrow">RESPONSE</p>
                    <p>{selectedHistoryEntry.response || "没有返回文本"}</p>
                  </div>
                </article>
              )}
            </div>
          ) : (
            <EmptyState
              title="当前搜索或时间筛选下没有对话"
              description="换个关键词，或者把时间范围放宽一些。"
            />
          )}
        </>
      ) : (
        <EmptyState title="还没有聊过天。" />
      )}
    </section>
  );
}
