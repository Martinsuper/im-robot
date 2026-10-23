import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "../app/appRuntime";
import { toUserMessage } from "../../lib/errors";
import { KnowledgePanel } from "./KnowledgePanel";
import { MemoryDetail } from "./MemoryDetail";
import type { MemoryItem } from "./memoryTypes";
import "./knowledge.css";

type Report = { collected: number; duplicates: number; archived: number };
type Status = {
  autoStore: boolean;
  lastRunAt: number;
  nextRunAt: number;
  knowledgeCount: number;
  pendingCount: number;
  report: Report;
};
const date = (time: number) => new Date(time * 1000).toLocaleString();

export function DailyKnowledgePanel({ onReview }: { onReview: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<MemoryItem | null>(null);
  const [referencesOpen, setReferencesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const refresh = useCallback(async () => {
    if (!isTauriRuntime) return;
    const [next, semantic, operational] = await Promise.all([
      invoke<Status>("knowledge_get_maintenance_status"),
      invoke<MemoryItem[]>("list_memories", {
        input: { memoryType: "semantic", status: "active", limit: 200 },
      }),
      invoke<MemoryItem[]>("list_memories", {
        input: { memoryType: "operational", status: "active", limit: 200 },
      }),
    ]);
    setStatus(next);
    setItems(
      [...semantic, ...operational]
        .filter((item) => !item.expiresAt || item.expiresAt * 1000 > Date.now())
        .sort((a, b) => b.updatedAt - a.updatedAt),
    );
    setError("");
  }, []);
  useEffect(() => {
    let active = true;
    const reload = () => {
      if (active)
        void refresh().catch((reason) => {
          if (active) setError(toUserMessage(reason));
        });
    };
    reload();
    if (!isTauriRuntime) return;
    const listener = listen("memories-updated", reload);
    void listener.catch((reason) => {
      if (active) setError(toUserMessage(reason));
    });
    const timer = window.setInterval(reload, 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
      void listener.then(
        (dispose) => dispose(),
        () => {},
      );
    };
  }, [refresh]);
  async function act(task: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await task();
      await refresh();
    } catch (reason) {
      setError(toUserMessage(reason));
    } finally {
      setBusy(false);
    }
  }
  const visible = items.filter((item) =>
    `${item.title} ${item.content} ${item.tags.join(" ")}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <section
      className="knowledge-panel daily-knowledge"
      aria-label="日常知识库"
    >
      <div className="daily-knowledge__intro">
        <h3>从日常使用中积累</h3>
        <p className="knowledge-help">
          个人偏好保存在记忆中，项目事实、方法和操作经验沉淀在这里，供后续对话检索。无需先导入文件。
        </p>
      </div>
      <section className="daily-knowledge__maintenance" aria-label="知识维护">
        <div className="knowledge-toolbar">
          <strong>
            {status ? `${status.knowledgeCount} 条知识` : "日常知识"}
          </strong>
          <button
            type="button"
            disabled={!status || busy}
            onClick={() =>
              void act(async () => {
                const report = await invoke<Report>("knowledge_maintain");
                setMessage(
                  `本次整理：收录 ${report.collected} 条，跳过重复 ${report.duplicates} 条，归档过期 ${report.archived} 条。`,
                );
              })
            }
          >
            {busy ? "处理中…" : "立即整理"}
          </button>
          <button type="button" onClick={onReview}>
            待确认{status ? `（${status.pendingCount}）` : ""}
          </button>
        </div>
        <label className="daily-knowledge__toggle">
          <input
            type="checkbox"
            checked={status?.autoStore ?? false}
            disabled={!status || busy}
            onChange={(event) => {
              const autoStore = event.currentTarget.checked;
              void act(() =>
                invoke("knowledge_configure_maintenance", { autoStore }),
              );
            }}
          />
          自动收录明确事实与项目知识
        </label>
        <p className="knowledge-help">
          开启后，每日整理会收录有用户原文依据的非敏感内容；疑似更正和同名冲突留待确认。不会自动覆盖已有知识。关闭后，候选均需确认，已收录内容保留。
        </p>
        {status && (
          <p className="knowledge-help">
            上次整理：{status.lastRunAt ? date(status.lastRunAt) : "尚未运行"} ·{" "}
            {status.nextRunAt
              ? `下次整理：${date(status.nextRunAt)}（应用运行时）`
              : "自动提取已暂停，定期整理同步暂停"}
          </p>
        )}
        {status?.lastRunAt ? (
          <p className="knowledge-help">
            上次整理结果：收录 {status.report.collected} 条，跳过重复{" "}
            {status.report.duplicates} 条，归档过期 {status.report.archived}{" "}
            条。
          </p>
        ) : null}
        {!isTauriRuntime && (
          <p className="knowledge-help">请在桌面应用中使用自动积累与维护。</p>
        )}
        {message && <p role="status">{message}</p>}
        {error && (
          <p role="alert">
            {error}
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(refresh)}
            >
              重试
            </button>
          </p>
        )}
      </section>
      <label>
        搜索已积累的知识
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="搜索项目、事实或操作经验"
        />
      </label>
      {status && status.knowledgeCount > items.length && (
        <p className="knowledge-help">
          当前展示与搜索最近 {items.length} 条知识。
        </p>
      )}
      <div className="daily-knowledge__list">
        {visible.map((item) => (
          <article className="daily-knowledge__item" key={item.id}>
            <button
              type="button"
              className="daily-knowledge__open"
              onClick={() => setSelected(item)}
            >
              <strong>{item.title}</strong>
              <span>{item.content}</span>
            </button>
            <p className="knowledge-source">
              {item.memoryType === "semantic" ? "项目与方法" : "操作经验"} ·
              更新于 {date(item.updatedAt)} ·{" "}
              <button type="button" onClick={() => setSelected(item)}>
                查看来源与修订
              </button>
            </p>
          </article>
        ))}
        {!visible.length && !error && (
          <p className="knowledge-help">
            {query
              ? "没有匹配的知识。"
              : "还没有积累的知识。日常对话中的项目事实会定期整理到这里；你也可以在“待确认”中先审核已有候选。"}
          </p>
        )}
      </div>
      <details
        className="daily-knowledge__references"
        onToggle={(event) => setReferencesOpen(event.currentTarget.open)}
      >
        <summary>参考资料（可选）</summary>
        <p className="knowledge-help">
          已有文件可作为补充资料；不影响日常知识的自动积累。
        </p>
        {referencesOpen && <KnowledgePanel />}
      </details>
      {selected && (
        <MemoryDetail
          key={selected.id}
          memory={selected}
          onClose={() => setSelected(null)}
          onDeleted={refresh}
          onUpdated={setSelected}
        />
      )}
    </section>
  );
}
