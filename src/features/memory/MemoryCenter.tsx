import { useStableEvent } from "../../hooks/useStableEvent";
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
import { MemoryExtractionControls } from "./MemoryExtractionControls";
import { OpenLoopReview } from "../soul/OpenLoopReview";
import { MemoryCard } from "./MemoryCard";
import { MemoryDetail } from "./MemoryDetail";
import { runCommandAndRefresh } from "../app/appRuntime";
import { toUserMessage } from "../../lib/errors";
import { EmptyState, ErrorState } from "../../components/feedback/States";
import { useToast } from "../../components/feedback/toastStore";
import { useTranslation } from "../i18n/I18nProvider";

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
  // 三个子视图各自持有错误状态：原先共用一个，切到别的子视图会看到上一个视图的报错。
  const [listError, setListError] = useState("");
  const [pendingError, setPendingError] = useState("");
  const [summariesError, setSummariesError] = useState("");
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

  const toast = useToast();
  const { t } = useTranslation();

  const loadMemories = useStableEvent(async () => {
    const input: ListMemoriesInput = {
      status: "active",
      limit: 100,
      memoryType: filterType !== "all" ? filterType : undefined,
    };
    try {
      const items = await runCommand<MemoryItem[]>("list_memories", { input });
      setMemories(items);
      setListError("");
    } catch (error) {
      // 不清空列表：读取失败要让用户看到「加载失败」，而不是伪装成「没有记录」。
      setListError(toUserMessage(error, "记录加载失败，请重试。"));
    }
  });

  async function loadRecent() {
    try {
      const items = await runCommand<MemoryItem[]>("get_recent_memories", { limit: 20 });
      setMemories(items);
      setListError("");
    } catch (error) {
      // 同上：失败不清空，保留上一次成功的结果并报错。
      setListError(toUserMessage(error, "记录加载失败，请重试。"));
    }
  }

  async function loadPending() {
    try {
      const items = await runCommand<MemoryCandidate[]>("get_pending_candidates", {});
      setPendingCandidates(items);
      setPendingError("");
    } catch (error) {
      // 同上：失败不清空，避免把「加载失败」显示成「没有待确认」。
      setPendingError(toUserMessage(error, "待确认列表加载失败，请重试。"));
    }
  }

  async function loadSummaries() {
    try {
      const items = await runCommand<ReflectionSummary[]>("get_memory_summaries", {
        limit: 5,
      });
      setSummaries(items);
      setSummariesError("");
    } catch (error) {
      // 同上：失败不清空，避免把「加载失败」显示成「还没有反思总结」。
      setSummariesError(toUserMessage(error, "反思总结加载失败，请重试。"));
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

  const searchMemories = useStableEvent(async (query: string) => {
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
      setListError("");
    } catch (error) {
      // 同上：搜索失败不清空结果，保留上一次成功的结果并报错。
      setListError(toUserMessage(error, "搜索失败，请重试。"));
    } finally {
      setIsSearching(false);
    }
  });

  const debouncedSearch = useCallback(
    (query: string) => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      searchTimer.current = setTimeout(() => {
        void searchMemories(query);
      }, 300);
    },
    [searchMemories],
  );

  useEffect(() => {
    if (!isTauriRuntime) return;
    let disposed = false;
    void Promise.resolve().then(() => { if (!disposed) { void loadMemories(); void loadPending(); void loadSummaries(); } });
    const unlisten = listen("memories-updated", () => {
      void loadMemories();
      void loadPending();
    });
    return () => {
      disposed = true;
      if (searchTimer.current) clearTimeout(searchTimer.current);
      void unlisten.then((dispose) => dispose());
    };
  }, [filterType, loadMemories]);

  async function handleDelete(id: string) {
    try {
      await runCommandAndRefresh("delete_memory", { id }, [reloadVisibleMemories]);
      setListError("");
    } catch (error) {
      toast.error(toUserMessage(error, t("memory.error.deleteFailed")));
    }
  }

  async function handlePin(id: string) {
    try {
      await runCommand("pin_memory", { id });
    } catch (error) {
      toast.error(toUserMessage(error, t("memory.error.pinFailed")));
    }
  }

  async function handleUnpin(id: string) {
    try {
      await runCommand("unpin_memory", { id });
    } catch (error) {
      toast.error(toUserMessage(error, t("memory.error.unpinFailed")));
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
      setListError("");
    } catch (error) {
      toast.error(toUserMessage(error, t("memory.error.feedbackFailed")));
    }
  }

  async function handleClearAll() {
    if (memories.length === 0) return;
    if (!confirm(t("memory.confirm.clearAll"))) return;
    setIsClearing(true);
    try {
      await runCommandAndRefresh("clear_memories", {}, [reloadVisibleMemories]);
      setListError("");
    } catch (error) {
      toast.error(toUserMessage(error, t("memory.error.clearFailed")));
    } finally {
      setIsClearing(false);
    }
  }

  async function handleReflectNow() {
    setIsReflecting(true);
    try {
      await runCommand("reflect_memory_now", {});
      await Promise.all([loadSummaries(), loadMemories()]);
      setListError("");
    } catch (error) {
      toast.error(toUserMessage(error, t("memory.error.reflectFailed")));
    } finally {
      setIsReflecting(false);
    }
  }

  async function handleConfirmCandidate(candidateId: string) {
    try {
      await runCommandAndRefresh("apply_memory_candidates", {
        input: { candidateId, confirmed: true },
      }, [loadPending, loadMemories]);
    } catch (error) {
      toast.error(toUserMessage(error, t("memory.error.confirmFailed")));
    }
  }

  async function handleRejectCandidate(candidateId: string) {
    try {
      await runCommand("reject_memory_candidate", { candidateId });
      await loadPending();
    } catch (error) {
      toast.error(toUserMessage(error, t("memory.error.rejectFailed")));
    }
  }

  async function handleExport() {
    try {
      const data = await runCommand<MemoryExport>("export_memories", {});
      const json = JSON.stringify(data, null, 2);
      await navigator.clipboard.writeText(json);
      toast.success(t("memory.export.copied"));
    } catch (error) {
      toast.error(toUserMessage(error, t("memory.error.exportFailed")));
    }
  }

  return (
    <section className="memory-center">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{t("memory.center.eyebrow")}</p>
          <h2>{t("memory.title")}</h2>
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
          <button type="button" onClick={handleExport} title={t("memory.actions.exportTitle")}>
            {t("memory.actions.export")}
          </button>
          <button
            type="button"
            onClick={handleReflectNow}
            disabled={isReflecting}
            title={t("memory.actions.reflectTitle")}
          >
            {isReflecting ? t("memory.actions.reflecting") : t("memory.actions.reflect")}
          </button>
          <button
            type="button"
            onClick={handleClearAll}
            disabled={isClearing || memories.length === 0}
          >
            {isClearing ? t("memory.actions.clearing") : t("memory.actions.clearAll")}
          </button>
        </div>
      </div>

      {/* Sub-view tabs */}
      <MemoryExtractionControls />
      <OpenLoopReview />
      <nav className="memory-sub-tabs">
        <button
          type="button"
          className={subView === "memories" ? "is-active" : ""}
          onClick={() => setSubView("memories")}
        >
          {t("memory.tabs.memories")}
        </button>
        <button
          type="button"
          className={subView === "pending" ? "is-active" : ""}
          onClick={() => {
            setSubView("pending");
            void loadPending();
          }}
        >
          {t("memory.tabs.pending", `待确认 (${pendingCandidates.length})`).replace("{count}", String(pendingCandidates.length))}
        </button>
        <button
          type="button"
          className={subView === "reflections" ? "is-active" : ""}
          onClick={() => {
            setSubView("reflections");
            void loadSummaries();
          }}
        >
          {t("memory.tabs.reflections")}
        </button>
      </nav>

      {subView === "memories" && (
        <>
          {/* Search bar */}
          <div className="memory-search">
            <input
              type="text"
              className="memory-search__input"
              placeholder={t("memory.search.placeholder")}
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
              {t("memory.view.all")}
            </button>
            <button
              type="button"
              className={view === "recent" ? "is-active" : ""}
              onClick={() => {
                setView("recent");
                void loadRecent();
              }}
            >
              {t("memory.view.recent")}
            </button>
            {view === "search" && (
              <span className="memory-search-info">
                {t("memory.center.searchResults").replace("{count}", String(memories.length))}
              </span>
            )}
          </div>

          {listError && (
            <ErrorState
              message={listError}
              onRetry={() => {
                setListError("");
                void reloadVisibleMemories();
              }}
              onDismiss={() => setListError("")}
            />
          )}

          {!listError && memories.length === 0 ? (
            <EmptyState
              title={view === "search" ? t("memory.center.searchNoResultTitle") : t("memory.center.noMemoriesTitle")}
              description={
                view === "search"
                  ? t("memory.center.emptySearchDescription").replace("{query}", searchQuery)
                  : t("memory.empty.noMemories")
              }
            />
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
          {pendingError && (
            <ErrorState
              message={pendingError}
              onRetry={() => {
                setPendingError("");
                void loadPending();
              }}
              onDismiss={() => setPendingError("")}
            />
          )}

          {!pendingError && pendingCandidates.length === 0 ? (
            <EmptyState
              title={t("memory.empty.noPending")}
              description={t("memory.center.pendingEmptyDescription")}
            />
          ) : (
            <div className="memory-list">
              {pendingCandidates.map((cand) => (
                <div key={cand.id} className="memory-card memory-card--pending">
                  <div className="memory-card__header">
                    <span className={`memory-type-badge memory-type-badge--${cand.memoryType}`}>
                      {t("memory.pending.badge").replace("{type}", cand.memoryType === "profile" ? t("memory.type.profile") : t("memory.type.event"))}
                    </span>
                    <span className="memory-card__source">{t("memory.pending.confidence").replace("{value}", (cand.confidence * 100).toFixed(0))}</span>
                  </div>
                  <h3 className="memory-card__title">{cand.title}</h3>
                  <p className="memory-card__content">{cand.content}</p>
                  <div className="memory-card__actions">
                    <button
                      type="button"
                      className="memory-confirm-btn"
                      onClick={() => handleConfirmCandidate(cand.id)}
                    >
                      {t("memory.pending.confirm")}
                    </button>
                    <button
                      type="button"
                      className="memory-reject-btn"
                      onClick={() => handleRejectCandidate(cand.id)}
                    >
                      {t("memory.pending.reject")}
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
          {summariesError && (
            <ErrorState
              message={summariesError}
              onRetry={() => {
                setSummariesError("");
                void loadSummaries();
              }}
              onDismiss={() => setSummariesError("")}
            />
          )}

          {!summariesError && summaries.length === 0 ? (
            <EmptyState
              title={t("memory.empty.noReflections")}
              description={t("memory.center.reflectionsEmptyDescription")}
            />
          ) : (
            <div className="reflection-list">
              {summaries.map((s) => (
                <div key={s.id} className="reflection-card">
                  <div className="reflection-card__header">
                    <span className={`reflection-badge reflection-badge--${s.summaryType}`}>
                      {s.summaryType === "daily" ? t("memory.reflections.daily") : t("memory.reflections.weekly")}
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
