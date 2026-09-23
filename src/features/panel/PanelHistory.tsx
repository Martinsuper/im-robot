import { useMemo, useState } from "react";
import type { ChatHistoryEntry } from "../../types/appTypes";
type ChatHistoryFilter = "all" | "attachment" | "screenshot" | "code" | "link" | "long";

const chatHistoryFilterOptions: Array<{ label: string; value: ChatHistoryFilter }> = [
  { label: "全部", value: "all" },
  { label: "附件", value: "attachment" },
  { label: "截图", value: "screenshot" },
  { label: "代码", value: "code" },
  { label: "链接", value: "link" },
  { label: "长回复", value: "long" },
];

function getChatHistoryTags(entry: ChatHistoryEntry): ChatHistoryFilter[] {
  const text = `${entry.prompt}\n${entry.response}`;
  const tags: ChatHistoryFilter[] = [];

  if (entry.prompt.includes("[附件")) tags.push("attachment");
  if (entry.prompt.includes("[截图")) tags.push("screenshot");
  if (/```|<\/?[a-z][\s\S]*>/i.test(text)) tags.push("code");
  if (/https?:\/\//i.test(text)) tags.push("link");
  if (entry.response.length > 600) tags.push("long");

  return tags;
}

function chatHistoryFilterLabel(filter: ChatHistoryFilter) {
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

function summarizeChatText(text: string, fallback: string) {
  const normalized = text.replace(/\s+/g, " ").trim() || fallback;
  return normalized.length > 140 ? `${normalized.slice(0, 140)}...` : normalized;
}

function chatHistoryMatchesSearch(entry: ChatHistoryEntry, search: string) {
  const keyword = search.trim().toLocaleLowerCase();
  if (!keyword) return true;

  return `${entry.prompt}\n${entry.response}`.toLocaleLowerCase().includes(keyword);
}

export function PanelHistory({ chatHistory, focusMinutes, onClear }: { chatHistory: ChatHistoryEntry[]; focusMinutes: number; onClear: () => Promise<void> }) {
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [historyFilter, setHistoryFilter] = useState<ChatHistoryFilter>("all");
  const [historySearch, setHistorySearch] = useState("");
  const filteredChatHistory = useMemo(
    () => {
      return chatHistory.filter((entry) => {
        const matchesFilter = historyFilter === "all" || getChatHistoryTags(entry).includes(historyFilter);
        return matchesFilter && chatHistoryMatchesSearch(entry, historySearch);
      });
    },
    [chatHistory, historyFilter, historySearch],
  );
  const selectedHistoryEntry = useMemo(() => {
    if (!filteredChatHistory.length) return undefined;
    return filteredChatHistory.find((entry) => entry.id === selectedHistoryId) ?? filteredChatHistory[0];
  }, [filteredChatHistory, selectedHistoryId]);
  return (
      <section className="panel-card panel-section panel-section--history">
        <div className="focus-summary">
          <span>今日专注</span>
          <strong>{focusMinutes} 分钟</strong>
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
