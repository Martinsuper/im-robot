import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  MemoryItem,
  ListMemoriesInput,
  SearchMemoriesInput,
  MemoryType,
  FeedbackInput,
  MEMORY_TYPE_OPTIONS,
} from "./memoryTypes";
import { MemoryCard } from "./MemoryCard";

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
    const unlisten = listen("memories-updated", () => {
      void loadMemories();
    });
    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, [filterType]);

  async function handleDelete(id: string) {
    try {
      await runCommand("delete_memory", { id });
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
      await runCommand("clear_memories", {});
      setError("");
    } catch {
      setError("清除失败");
    } finally {
      setIsClearing(false);
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
          <button
            type="button"
            onClick={handleClearAll}
            disabled={isClearing || memories.length === 0}
          >
            {isClearing ? "清除中…" : "清除全部"}
          </button>
        </div>
      </div>

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
            <MemoryCard
              key={memory.id}
              memory={memory}
              onDelete={handleDelete}
              onPin={handlePin}
              onUnpin={handleUnpin}
              onFeedback={handleFeedback}
            />
          ))}
        </div>
      )}
    </section>
  );
}
