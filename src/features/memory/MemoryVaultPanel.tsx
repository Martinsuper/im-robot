import { useCallback, useEffect, useState } from "react";
import { invokeCommand } from "../../generated/ipc";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { toUserMessage } from "../../lib/errors";
import "./vault.css";

type Issue = {
  memoryId: string | null;
  path: string;
  kind: string;
  message: string;
  canResolve: boolean;
};
type Report = {
  syncedAt: number;
  exported: number;
  imported: number;
  removed: number;
  issues: Issue[];
  error: string | null;
};
type Status = {
  config: { enabled: boolean; directory: string; pausedReason: string | null };
  report: Report;
  trackedCount: number;
  persistent: boolean;
};
type Preview = {
  memoryId: string;
  path: string;
  pikoTitle: string | null;
  pikoContent: string | null;
  fileTitle: string | null;
  fileContent: string | null;
  pikoVersion: string | null;
  fileVersion: string | null;
  active: boolean;
  pikoMetadata: string | null;
  fileMetadata: string | null;
};
const desktop = "__TAURI_INTERNALS__" in window;

export function MemoryVaultPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    if (!desktop) return;
    const result = await invokeCommand("memory_vault_status", {});
    if (!result?.config || !result?.report)
      throw new Error("Markdown 同步状态格式无效");
    setStatus(result);
  }, []);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    async function refresh() {
      try {
        const result = await invokeCommand("memory_vault_status", {});
        if (!disposed && result?.config && result?.report) setStatus(result);
      } catch (e) {
        if (!disposed) setError(toUserMessage(e, "Markdown 状态加载失败"));
      }
    }
    void refresh();
    const listening = listen("memory-vault-updated", () => {
      void refresh();
    });
    return () => {
      disposed = true;
      void listening.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (e) {
      setError(toUserMessage(e, "Markdown 同步失败"));
    } finally {
      setBusy(false);
    }
  }
  const enabled = status?.config.enabled ?? false;
  const available = desktop && status?.persistent;
  const pending = status?.report.issues ?? [];
  const activePreview =
    preview &&
    pending.some(
      (issue) =>
        issue.path === preview.path && issue.memoryId === preview.memoryId,
    )
      ? preview
      : null;
  return (
    <details
      className="memory-vault"
      onToggle={(e) => {
        if (e.currentTarget.open && desktop)
          void load().catch((e) =>
            setError(toUserMessage(e, "Markdown 状态加载失败")),
          );
      }}
    >
      <summary>
        Markdown 记忆库{" "}
        <span>
          {status
            ? !status.persistent
              ? "已停用"
              : status.report.error
                ? "同步出错"
                : pending.length
                  ? `${pending.length} 项待处理`
                  : enabled
                    ? "自动同步中"
                    : "已暂停"
            : ""}
        </span>
      </summary>
      <div className="memory-vault__body">
        <p>
          按用户档案、事件记忆、项目知识、操作记录、反思总结分类保存。Piko
          运行时约每 15 秒双向同步一次；在分类目录中编辑或新增 Markdown
          笔记后，会更新记忆及检索。
        </p>
        {!desktop && <p>请在桌面应用中使用 Markdown 同步。</p>}
        {status && (
          <>
            <p className="memory-vault__path">{status.config.directory}</p>
            <p>
              已同步 {status.trackedCount} 条记忆 ·{" "}
              {status.report.syncedAt
                ? `上次同步 ${new Date(status.report.syncedAt * 1000).toLocaleString()}`
                : "尚未同步"}
            </p>
            {!status.persistent && (
              <p role="alert">当前使用临时数据库，Markdown 同步已停用。</p>
            )}
            {status.config.pausedReason && (
              <p role="status">{status.config.pausedReason}</p>
            )}
          </>
        )}
        <div className="memory-vault__actions">
          <button
            type="button"
            disabled={busy || !available}
            onClick={() =>
              void perform(async () => {
                const updated = await invokeCommand("memory_vault_configure", {
                  enabled: !enabled,
                  directory: null,
                });
                setStatus(updated);
                setMessage(
                  enabled ? "已暂停同步。文件会保留。" : "已恢复自动同步。",
                );
              })
            }
          >
            {enabled ? "暂停同步" : "恢复同步"}
          </button>
          <button
            type="button"
            disabled={busy || !available || !enabled}
            onClick={() =>
              void perform(async () => {
                const report = await invokeCommand("memory_vault_sync", {});
                await load();
                setMessage(
                  `本次写出 ${report.exported} 条，读入 ${report.imported} 条，移除 ${report.removed} 个文件。`,
                );
              })
            }
          >
            立即同步
          </button>
          <button
            type="button"
            disabled={busy || !available}
            onClick={() =>
              void perform(async () => {
                if (!status) return;
                if (enabled && status.trackedCount === 0) {
                  await invokeCommand("memory_vault_sync", {});
                  await load();
                }
                await invokeCommand("memory_vault_open_directory", {});
              })
            }
          >
            打开文件夹
          </button>
          <button
            type="button"
            disabled={busy || !available}
            onClick={() =>
              void perform(async () => {
                const selected = await open({
                  directory: true,
                  multiple: false,
                  title: "选择 Markdown 记忆库目录",
                });
                if (selected && !Array.isArray(selected)) {
                  setStatus(
                    await invokeCommand("memory_vault_configure", {
                      enabled,
                      directory: selected,
                    }),
                  );
                  setPreview(null);
                  setMessage("目录已切换，旧目录文件保留并停止同步。");
                }
              })
            }
          >
            选择目录
          </button>
        </div>
        <p>
          只同步有效的非私密记忆。两边同时修改时由你选择；删除 Markdown
          文件需要在这里确认，才会让 Piko 忘记。替换文件前的恢复副本位于
          .piko-history，不参与检索。
        </p>
        {(error || status?.report.error) && (
          <p role="alert">{error || status?.report.error}</p>
        )}
        {(busy || message) && <p role="status">{busy ? "处理中…" : message}</p>}
        {pending.length > 0 && (
          <section aria-label="Markdown 同步待处理">
            <h4>待处理（{pending.length}）</h4>
            {pending.map((issue, index) => (
              <article
                className="memory-vault__issue"
                key={`${issue.path}:${index}`}
              >
                <strong>{issue.path}</strong>
                <p>{issue.message}</p>
                {issue.canResolve && issue.memoryId && (
                  <button
                    type="button"
                    disabled={busy || !available || !enabled}
                    onClick={() =>
                      void perform(async () => {
                        setPreview(
                          (await invokeCommand("memory_vault_preview", {
                            memoryId: issue.memoryId as string,
                            path: issue.path,
                          })) as Preview,
                        );
                      })
                    }
                  >
                    比较并处理
                  </button>
                )}
              </article>
            ))}
          </section>
        )}
        {activePreview && (
          <section
            className="memory-vault__comparison"
            aria-label="比较 Markdown 与 Piko"
          >
            <h4>比较：{activePreview.path}</h4>
            <article>
              <h5>Piko{!activePreview.active ? "（已失效或不存在）" : ""}</h5>
              <strong>{activePreview.pikoTitle}</strong>
              <p>{activePreview.pikoMetadata}</p>
              <pre>{activePreview.pikoContent ?? "无此记忆"}</pre>
            </article>
            <article>
              <h5>Markdown</h5>
              <strong>{activePreview.fileTitle}</strong>
              <p>{activePreview.fileMetadata}</p>
              <pre>{activePreview.fileContent ?? "文件已删除或移走"}</pre>
            </article>
            <div className="memory-vault__actions">
              {(["piko", "file"] as const).map((choice) => {
                const label =
                  choice === "piko"
                    ? activePreview.active
                      ? activePreview.fileVersion
                        ? "保留 Piko 版本"
                        : "恢复 Markdown 文件"
                      : "删除 Markdown 文件"
                    : activePreview.fileVersion
                      ? activePreview.active
                        ? "使用 Markdown 版本"
                        : "另存为新记忆"
                      : "确认让 Piko 忘记";
                return (
                  <button
                    type="button"
                    key={choice}
                    disabled={busy}
                    onClick={() => {
                      if (!confirm(`确定${label}？请先检查上方两侧内容。`))
                        return;
                      void perform(async () => {
                        await invokeCommand("memory_vault_resolve", {
                          input: {
                            memoryId: activePreview.memoryId,
                            path: activePreview.path,
                            choice,
                            pikoVersion: activePreview.pikoVersion,
                            fileVersion: activePreview.fileVersion,
                          },
                        });
                        setPreview(null);
                        await load();
                        setMessage("已处理并重新同步。");
                      });
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              关闭比较
            </button>
          </section>
        )}
      </div>
    </details>
  );
}
