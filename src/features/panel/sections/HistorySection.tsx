import type { Dispatch, SetStateAction } from "react";
import type { ChatHistoryEntry, FocusSnapshot } from "../../../types/appTypes";
import {
  chatHistoryFilterLabel,
  chatHistoryFilterOptions,
  chatHistoryMatchesSearch,
  formatChatHistoryTime,
  getChatHistoryTags,
  summarizeChatText,
  type ChatHistoryFilter,
} from "./chatHistoryFilters";

interface HistorySectionProps {
  className: string;
  focusState: FocusSnapshot;
  chatHistory: ChatHistoryEntry[];
  filteredChatHistory: ChatHistoryEntry[];
  selectedHistoryEntry: ChatHistoryEntry | undefined;
  historyFilter: ChatHistoryFilter;
  historySearch: string;
  setHistoryFilter: Dispatch<SetStateAction<ChatHistoryFilter>>;
  setHistorySearch: Dispatch<SetStateAction<string>>;
  setSelectedHistoryId: Dispatch<SetStateAction<string>>;
  clearChatHistory: () => Promise<void>;
}

export function HistorySection({
  className,
  focusState,
  chatHistory,
  filteredChatHistory,
  selectedHistoryEntry,
  historyFilter,
  historySearch,
  setHistoryFilter,
  setHistorySearch,
  setSelectedHistoryId,
  clearChatHistory,
}: HistorySectionProps) {
  return (
    <section className={className}>
      <div className="focus-summary">
        <span>今日专注</span>
        <strong>{focusState.todayMinutes} 分钟</strong>
      </div>
      <div className="section-heading">
        <div>
          <p className="eyebrow">CHAT HISTORY</p>
          <h2>最近对话</h2>
        </div>
        <button type="button" disabled={!chatHistory.length} onClick={() => void clearChatHistory()}>
          清除历史
        </button>
      </div>
      {chatHistory.length ? (
        <div className="chat-history-browser">
          <div className="chat-history-search">
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
          <div className="history-filter-bar" aria-label="历史筛选">
            {chatHistoryFilterOptions.map((option) => {
              const count =
                option.value === "all"
                  ? chatHistory.filter((entry) => chatHistoryMatchesSearch(entry, historySearch)).length
                  : chatHistory.filter(
                      (entry) =>
                        getChatHistoryTags(entry).includes(option.value) &&
                        chatHistoryMatchesSearch(entry, historySearch),
                    ).length;
              return (
                <button
                  className={historyFilter === option.value ? "is-active" : ""}
                  disabled={count === 0}
                  key={option.value}
                  type="button"
                  onClick={() => setHistoryFilter(option.value)}
                >
                  {option.label}
                  <span>{count}</span>
                </button>
              );
            })}
          </div>
          {filteredChatHistory.length ? (
            <div className="chat-history-layout">
              <ul className="history-list chat-history-list" aria-label="最近对话列表">
                {filteredChatHistory.map((entry) => {
                  const tags = getChatHistoryTags(entry);
                  return (
                    <li className={entry.id === selectedHistoryEntry?.id ? "is-active" : ""} key={entry.id}>
                      <button type="button" onClick={() => setSelectedHistoryId(entry.id)}>
                        <span className="chat-history-list__time">{formatChatHistoryTime(entry.createdAt)}</span>
                        <strong>{summarizeChatText(entry.prompt, "未命名对话")}</strong>
                        <span>{summarizeChatText(entry.response, "没有返回文本")}</span>
                        {tags.length ? (
                          <div className="chat-history-tags">
                            {tags.map((tag) => (
                              <span key={tag}>{chatHistoryFilterLabel(tag)}</span>
                            ))}
                          </div>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {selectedHistoryEntry && (
                <article className="chat-history-detail">
                  <div className="chat-history-detail__meta">
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
            <p className="empty-state">当前搜索或筛选下没有对话。</p>
          )}
        </div>
      ) : (
        <p className="empty-state">暂无对话历史。</p>
      )}
    </section>
  );
}
