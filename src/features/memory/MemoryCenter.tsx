import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  MemoryItem,
  ListMemoriesInput,
  MemoryType,
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
  const [isClearing, setIsClearing] = useState(false);
  const [error, setError] = useState("");

  async function loadMemories() {
    const input: ListMemoriesInput = {
      status: "active",
      limit: 100,
      memoryType: filterType !== "all" ? filterType : undefined,
    };
    try {
      const items = await runCommand<MemoryItem[]>("list_memories", { input });
      setMemories(items);
    } catch {
      setMemories([]);
    }
  }

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
    } catch {
      setError("删除失败");
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
            onChange={(e) => setFilterType(e.currentTarget.value as MemoryType | "all")}
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

      {error && <p className="memory-error">{error}</p>}

      {memories.length === 0 ? (
        <p className="empty-state">还没有记忆。Piko 会在和你互动时逐渐记住重要的事。</p>
      ) : (
        <div className="memory-list">
          {memories.map((memory) => (
            <MemoryCard key={memory.id} memory={memory} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </section>
  );
}
