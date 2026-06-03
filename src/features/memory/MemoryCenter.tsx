import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  MemoryItem,
  ListMemoriesInput,
  SearchMemoriesInput,
  MemoryType,
  FeedbackInput,
  MemoryCandidate,
  ReflectionSummary,
  MemoryExport,
  MEMORY_TYPE_OPTIONS,
} from "./memoryTypes";
import { MemoryCard } from "./MemoryCard";
import { MemoryDetail } from "./MemoryDetail";
import { runCommandAndRefresh } from "../app/appRuntime";

const isTauriRuntime = "__TAURI_INTERNALS__" in window;

function runCommand<T>(command: string, args?: Record<string, unknown>) {
  return isTauriRuntime ? invoke<T>(command, args) : Promise.resolve([] as unknown as T);
}

export function MemoryCenter() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [filterType, setFilterType] = useState<MemoryType | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<"list" | "search" | "recent">("list");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Detail modal
  const [selectedMemory, setSelectedMemory] = useState<MemoryItem | null>(null);

  // Pending candidates
  const [pendingCandidates, setPendingCandidates] = useState<MemoryCandidate[]>([]);

  // Reflection summaries
  const [summaries, setSummaries] = useState<ReflectionSummary[]>([]);
  const [isReflecting, setIsReflecting] = useState(false);

  // Sub-tab for advanced views
  const [subView, setSubView] = useState<"memories" | "pending" | "reflections">("memories");

  async function loadMemories() {
    const input: ListMemoriesInput = {
      status: "active",
      limit: 100,
      memoryType: filterType !== "all" ? filterType : undefined,
    };
    try {
      const items = await runCommand<MemoryItem[]>("list_memories", { input });
      setMemories(items);
      setError("");
    } catch {
      setMemories([]);
    }
  }

  async function loadRecent() {
    try {
      const items = await runCommand<MemoryItem[]>("get_recent_memories", { limit: 20 });
      setMemories(items);
      setError("");
    } catch {
      setMemories([]);
    }
  }

  async function loadPending() {
    try {
      const items = await runCommand<MemoryCandidate[]>("get_pending_candidates", {});
      setPendingCandidates(items);
    } catch {
      setPendingCandidates([]);
    }
  }

  async function loadSummaries() {
    try {
      const items = await runCommand<ReflectionSummary[]>("get_memory_summaries", {
        limit: 5,
      });
      setSummaries(items);
    } catch {
      setSummaries([]);
    }
  }

  async function reloadVisibleMemories() {
    if (view === "recent") {
      await loadRecent();
      return;
    }

    if (view === "search" && searchQuery.trim()) {
      await searchMemories(searchQuery);
      return;
    }

    await loadMemories();
  }

  async function searchMemories(query: string) {
    if (!query.trim()) {
      setView("list");
      void loadMemories();
      return;
    }
    setIsSearching(true);
    setView("search");
    const input: SearchMemoriesInput = {
      query: query.trim(),
      memoryType: filterType !== "all" ? filterType : undefined,
      limit: 30,
    };
    try {
      const items = await runCommand<MemoryItem[]>("search_memories", { input });
      setMemories(items);
      setError("");
    } catch {
      setMemories([]);
    } finally {
      setIsSearching(false);
    }
  }

  const debouncedSearch = useCallback(
    (query: string) => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      searchTimer.current = setTimeout(() => {
        void searchMemories(query);
      }, 300);
    },
    [filterType],
  );

  useEffect(() => {
    if (!isTauriRuntime) return;
    void loadMemories();
    void loadPending();
    void loadSummaries();
    const unlisten = listen("memories-updated", () => {
      void loadMemories();
      void loadPending();
    });
    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, [filterType]);

  async function handleDelete(id: string) {
    try {
      await runCommandAndRefresh("delete_memory", { id }, [reloadVisibleMemories]);
      setError("");
    } catch {
      setError("删除失败");
    }
  }

  async function handlePin(id: string) {
    try {
      await runCommand("pin_memory", { id });
    } catch {
      setError("置顶失败");
    }
  }

  async function handleUnpin(id: string) {
    try {
      await runCommand("unpin_memory", { id });
    } catch {
      setError("取消置顶失败");
    }
  }

  async function handleFeedback(id: string, feedbackType: string) {
    const input: FeedbackInput = {
      memoryId: id,
      feedbackType,
      value: feedbackType === "useful" || feedbackType === "correct" ? 1 : -1,
    };
    try {
      await runCommand("feedback_memory", { input });
      setError("");
    } catch {
      setError("反馈提交失败");
    }
  }

  async function handleClearAll() {
    if (memories.length === 0) return;
    if (!confirm("确定要清除全部记忆吗？此操作不可撤销。")) return;
    setIsClearing(true);
    try {
      await runCommandAndRefresh("clear_memories", {}, [reloadVisibleMemories]);
      setError("");
    } catch {
      setError("清除失败");
    } finally {
      setIsClearing(false);
    }
  }

  async function handleReflectNow() {
    setIsReflecting(true);
    try {
      await runCommand("reflect_memory_now", {});
      await Promise.all([loadSummaries(), loadMemories()]);
      setError("");
    } catch {
      setError("反思失败");
    } finally {
      setIsReflecting(false);
    }
  }

  async function handleConfirmCandidate(candidateId: string) {
    try {
      await runCommandAndRefresh("apply_memory_candidates", {
        input: { candidateId, confirmed: true },
      }, [loadPending, loadMemories]);
    } catch {
      setError("确认失败");
    }
  }

  async function handleRejectCandidate(candidateId: string) {
    try {
      await runCommand("reject_memory_candidate", { candidateId });
      await loadPending();
    } catch {
      setError("拒绝失败");
    }
  }

  async function handleExport() {
    try {
      const data = await runCommand<MemoryExport>("export_memories", {});
      const json = JSON.stringify(data, null, 2);
      await navigator.clipboard.writeText(json);
      setError("已复制记忆导出到剪贴板");
    } catch {
      setError("导出失败");
    }
  }

  return (
    <section className="memory-center">
      <div className="section-heading">
        <div>
          <p className="eyebrow">MEMORY CENTER</p>
          <h2>记忆中心</h2>
        </div>
        <div className="section-heading__actions">
          <select
            value={filterType}
            onChange={(e) => {
              setFilterType(e.currentTarget.value as MemoryType | "all");
            }}
            className="memory-filter-select"
          >
            {MEMORY_TYPE_OPTIONS.map(({ label, value }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button type="button" onClick={handleExport} title="导出记忆">
            导出
          </button>
          <button
            type="button"
            onClick={handleReflectNow}
            disabled={isReflecting}
            title="运行记忆反思"
          >
            {isReflecting ? "反思中…" : "反思"}
          </button>
          <button
            type="button"
            onClick={handleClearAll}
            disabled={isClearing || memories.length === 0}
          >
            {isClearing ? "清除中…" : "清除全部"}
          </button>
        </div>
      </div>

      {/* Sub-view tabs */}
      <nav className="memory-sub-tabs">
        <button
          type="button"
          className={subView === "memories" ? "is-active" : ""}
          onClick={() => setSubView("memories")}
        >
          记忆列表
        </button>
        <button
          type="button"
          className={subView === "pending" ? "is-active" : ""}
          onClick={() => {
            setSubView("pending");
            void loadPending();
          }}
        >
          待确认 ({pendingCandidates.length})
        </button>
        <button
          type="button"
          className={subView === "reflections" ? "is-active" : ""}
          onClick={() => {
            setSubView("reflections");
            void loadSummaries();
          }}
        >
          反思总结
        </button>
      </nav>

      {subView === "memories" && (
        <>
          {/* Search bar */}
          <div className="memory-search">
            <input
              type="text"
              className="memory-search__input"
              placeholder="搜索记忆…"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.currentTarget.value);
                debouncedSearch(e.currentTarget.value);
              }}
            />
            {isSearching && <span className="memory-search__loading">⏳</span>}
            {searchQuery && (
              <button
                type="button"
                className="memory-search__clear"
                onClick={() => {
                  setSearchQuery("");
                  setView("list");
                  void loadMemories();
                }}
              >
                ✕
              </button>
            )}
          </div>

          {/* View toggle */}
          <div className="memory-view-toggle">
            <button
              type="button"
              className={view === "list" ? "is-active" : ""}
              onClick={() => {
                setView("list");
                void loadMemories();
              }}
            >
              全部
            </button>
            <button
              type="button"
              className={view === "recent" ? "is-active" : ""}
              onClick={() => {
                setView("recent");
                void loadRecent();
              }}
            >
              最近
            </button>
            {view === "search" && (
              <span className="memory-search-info">
                找到 {memories.length} 条结果
              </span>
            )}
          </div>

          {error && <p className="memory-error">{error}</p>}

          {memories.length === 0 ? (
            <p className="empty-state">
              {view === "search"
                ? `没有找到与"${searchQuery}"相关的记忆。`
                : "还没有记忆。Piko 会在和你互动时逐渐记住重要的事。"}
            </p>
          ) : (
            <div className="memory-list">
              {memories.map((memory) => (
                <div key={memory.id} onClick={() => setSelectedMemory(memory)} className="memory-card-wrapper">
                  <MemoryCard
                    memory={memory}
                    onDelete={handleDelete}
                    onPin={handlePin}
                    onUnpin={handleUnpin}
                    onFeedback={handleFeedback}
                  />
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {subView === "pending" && (
        <>
          {pendingCandidates.length === 0 ? (
            <p className="empty-state">没有待确认的记忆推断。</p>
          ) : (
            <div className="memory-list">
              {pendingCandidates.map((cand) => (
                <div key={cand.id} className="memory-card memory-card--pending">
                  <div className="memory-card__header">
                    <span className={`memory-type-badge memory-type-badge--${cand.memoryType}`}>
                      待确认 · {cand.memoryType === "profile" ? "用户档案" : "事件记忆"}
                    </span>
                    <span className="memory-card__source">置信度 {(cand.confidence * 100).toFixed(0)}%</span>
                  </div>
                  <h3 className="memory-card__title">{cand.title}</h3>
                  <p className="memory-card__content">{cand.content}</p>
                  <div className="memory-card__actions">
                    <button
                      type="button"
                      className="memory-confirm-btn"
                      onClick={() => handleConfirmCandidate(cand.id)}
                    >
                      ✓ 确认记住
                    </button>
                    <button
                      type="button"
                      className="memory-reject-btn"
                      onClick={() => handleRejectCandidate(cand.id)}
                    >
                      ✕ 忽略
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {subView === "reflections" && (
        <>
          {summaries.length === 0 ? (
            <p className="empty-state">还没有反思总结。点击"反思"按钮运行第一次反思。</p>
          ) : (
            <div className="reflection-list">
              {summaries.map((s) => (
                <div key={s.id} className="reflection-card">
                  <div className="reflection-card__header">
                    <span className={`reflection-badge reflection-badge--${s.summaryType}`}>
                      {s.summaryType === "daily" ? "日反思" : "周反思"}
                    </span>
                    <span className="reflection-date">
                      {new Date(s.createdAt * 1000).toLocaleDateString("zh-CN")}
                    </span>
                  </div>
                  <pre className="reflection-content">{s.content}</pre>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Memory Detail Modal */}
      {selectedMemory && (
        <MemoryDetail
          memory={selectedMemory}
          onClose={() => setSelectedMemory(null)}
          onDeleted={reloadVisibleMemories}
          onUpdated={(updated) => setSelectedMemory(updated)}
        />
      )}
    </section>
  );
}
