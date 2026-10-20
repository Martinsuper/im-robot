import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MemoryItem } from "./memoryTypes";
import { toUserMessage } from "../../lib/errors";

type Revision = { previous: MemoryItem; changedAt: number; reason: string };
type Provenance = { sourceId: string; capturedAt: number };

export function MemoryHistory({
  memory,
  onReplaced,
}: {
  memory: MemoryItem;
  onReplaced: () => void | Promise<void>;
}) {
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [provenance, setProvenance] = useState<Provenance | null>(null);
  const [alternatives, setAlternatives] = useState<MemoryItem[]>([]);
  const [replacement, setReplacement] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    void Promise.all([
      invoke<Revision[]>("memory_revisions", { id: memory.id }),
      invoke<Provenance | null>("memory_get_provenance", { id: memory.id }),
      invoke<MemoryItem[]>("list_memories", {
        input: { status: "active", memoryType: memory.memoryType, limit: 200 },
      }),
    ])
      .then(([history, source, items]) => {
        if (!disposed) {
          setRevisions(history);
          setProvenance(source);
          setAlternatives(items.filter((item) => item.id !== memory.id));
          setError("");
        }
      })
      .catch((e) => {
        if (!disposed) setError(toUserMessage(e, "记忆历史加载失败"));
      });
    return () => {
      disposed = true;
    };
  }, [memory.id, memory.updatedAt, memory.content, memory.memoryType]);

  return (
    <details className="memory-history">
      <summary>来源、修订与替代</summary>
      {error && <p role="alert">{error}</p>}
      {provenance ? (
        <p>
          来源对话：<code>{provenance.sourceId}</code> · 提取于{" "}
          {new Date(provenance.capturedAt * 1000).toLocaleString()}
        </p>
      ) : (
        <p>这条记忆尚无可追溯的原始对话编号。</p>
      )}
      <p>修改后的内容用于后续回答，旧内容仅保留为修订记录。</p>
      {revisions.map((revision, i) => (
        <article key={i}>
          <small>
            {new Date(revision.changedAt * 1000).toLocaleString()} ·{" "}
            {revision.reason === "markdownEdit"
              ? "Markdown 同步前"
              : "用户修正前"}
          </small>
          <p>
            <strong>{revision.previous.title}</strong>
          </p>
          <p>{revision.previous.content}</p>
        </article>
      ))}
      {revisions.length === 0 && <p>暂无修订记录。</p>}
      {alternatives.length > 0 && (
        <div className="memory-edit">
          <label>
            使用另一条已保存的事实替代本条记忆
            <select
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              disabled={busy}
            >
              <option value="">选择替代记忆</option>
              {alternatives.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!replacement || busy}
            onClick={() => {
              if (
                !confirm(
                  "替代后，本条记忆将退出后续召回，并保留替代关系。确定继续？",
                )
              )
                return;
              setBusy(true);
              setError("");
              void invoke("supersede_memory", {
                oldId: memory.id,
                newId: replacement,
              })
                .then(onReplaced)
                .catch((e) => setError(toUserMessage(e, "替代记忆失败")))
                .finally(() => setBusy(false));
            }}
          >
            确认替代
          </button>
        </div>
      )}
    </details>
  );
}
