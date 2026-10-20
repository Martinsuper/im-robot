import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { toUserMessage } from "../../lib/errors";
import "./knowledge.css";

type Settings = {
  enabled: boolean;
  endpoint: string;
  model: string;
  allowRemote: boolean;
  revision: number;
};
type Document = {
  id: string;
  title: string;
  path: string;
  scope: string;
  updatedAt: number;
  chunkCount: number;
};
type Hit = {
  id: string;
  sourceType: string;
  title: string;
  source: string;
  locator: string;
  scope: string;
  content: string;
  score: number;
};
type ImportReport = { imported: number; unchanged: number; errors: string[] };
type IndexReport = { indexed: number; remaining: number };
const defaults: Settings = {
  enabled: false,
  endpoint: "http://localhost:11434/v1/embeddings",
  model: "bge-m3",
  allowRemote: false,
  revision: 0,
};
const desktop = "__TAURI_INTERNALS__" in window;

export function KnowledgePanel() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [settings, setSettings] = useState<Settings>(defaults);
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [scope, setScope] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const stop = useRef(false);

  async function load() {
    setDocuments(await invoke<Document[]>("knowledge_list_documents"));
  }
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    void Promise.all([
      invoke<Document[]>("knowledge_list_documents"),
      invoke<Settings>("knowledge_get_settings"),
    ])
      .then(([docs, config]) => {
        if (!disposed) {
          setDocuments(docs);
          setSettings(config);
        }
      })
      .catch((e) => {
        if (!disposed) setError(toUserMessage(e, "知识库加载失败"));
      });
    return () => {
      disposed = true;
      stop.current = true;
    };
  }, []);

  async function perform(label: string, action: () => Promise<void>) {
    if (!desktop) {
      setError("请在桌面应用中使用知识库。");
      return;
    }
    setBusy(label);
    setError("");
    setMessage("");
    try {
      await action();
    } catch (e) {
      setError(toUserMessage(e, `${label}失败`));
    } finally {
      setBusy("");
    }
  }
  async function importPaths(paths: string[], projectScope = scope.trim()) {
    setImportErrors([]);
    const report = await invoke<ImportReport>("knowledge_import", {
      paths,
      scope: projectScope,
    });
    setMessage(
      `已导入或更新 ${report.imported} 个文件，${report.unchanged} 个未变化。${settings.enabled ? "请建立语义索引以启用语义召回。" : "关键词检索已可用。"}`,
    );
    setImportErrors(report.errors);
    setHits([]);
    setSearched(false);
    await load();
  }
  async function choose(folder: boolean) {
    await perform("导入", async () => {
      const selected = await open({
        directory: folder,
        multiple: true,
        ...(!folder
          ? {
              filters: [
                {
                  name: "知识文档",
                  extensions: ["md", "markdown", "txt", "pdf"],
                },
              ],
            }
          : {}),
      });
      if (selected)
        await importPaths(Array.isArray(selected) ? selected : [selected]);
    });
  }
  async function reindex() {
    await perform("建立索引", async () => {
      stop.current = false;
      let total = 0;
      do {
        const result = await invoke<IndexReport>("knowledge_reindex");
        total += result.indexed;
        setMessage(`本次已索引 ${total} 个片段，剩余 ${result.remaining} 个。`);
        if (result.remaining === 0 || result.indexed === 0) break;
      } while (!stop.current);
    });
  }
  function updateSettings(update: Partial<Settings>) {
    setSettings((previous) => ({ ...previous, ...update }));
    setDirty(true);
  }

  return (
    <div className="knowledge-panel">
      {!desktop && <p role="status">请在桌面应用中导入资料和配置语义检索。</p>}
      <p className="knowledge-help">
        资料保存在本机。支持 UTF-8 Markdown、TXT 和带文字层的 PDF；扫描件请先
        OCR。重新导入同一路径会更新内容；文件夹导入最多 200 个文件，单文件最多
        20 MB。
      </p>
      <div className="knowledge-toolbar">
        <label>
          项目范围（可选）
          <input
            value={scope}
            maxLength={120}
            disabled={!!busy || !desktop}
            onChange={(e) => {
              setScope(e.target.value);
              setHits([]);
              setSearched(false);
            }}
            placeholder="例如 piko；留空为全部项目"
          />
        </label>
        <button
          type="button"
          disabled={!!busy || !desktop}
          onClick={() => void choose(false)}
        >
          导入文件
        </button>
        <button
          type="button"
          disabled={!!busy || !desktop}
          onClick={() => void choose(true)}
        >
          导入文件夹
        </button>
      </div>
      <p className="knowledge-help">
        导入时留空表示通用资料。搜索指定项目时，同时包含通用资料。文件更新后可点击“重新索引文件”。
      </p>
      <form
        className="knowledge-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          void perform("搜索", async () => {
            const result = await invoke<{
              hits: Hit[];
              warning: string | null;
            }>("knowledge_search", { query, scope: scope.trim() || null });
            setHits(result.hits);
            setSearched(true);
            if (result.warning) setMessage(result.warning);
          });
        }}
      >
        <label className="knowledge-query">
          搜索记忆和资料
          <input
            value={query}
            maxLength={10000}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="例如：发布前需要做什么？"
          />
        </label>
        <button disabled={!!busy || !desktop || !query.trim()}>搜索</button>
      </form>
      {error && (
        <p role="alert" className="knowledge-error">
          {error}
        </p>
      )}
      {(message || busy) && (
        <p role="status">
          {busy ? `${busy}… ` : ""}
          {message}
        </p>
      )}
      {importErrors.length > 0 && (
        <details open>
          <summary>部分文件未导入（{importErrors.length}）</summary>
          <ul>
            {importErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </details>
      )}
      {searched && (
        <section aria-label="检索结果">
          <h3>检索结果（{hits.length}）</h3>
          {hits.length === 0 && (
            <p>没有找到相关内容。可换用关键词，或检查语义索引是否已建立。</p>
          )}
          {hits.map((hit) => (
            <article className="memory-card" key={hit.id}>
              <h4>
                {hit.title} {hit.scope && <small>· {hit.scope}</small>}
              </h4>
              <p className="knowledge-source">
                {hit.sourceType === "memory"
                  ? "用户记忆"
                  : `${hit.source} · ${hit.locator}`}
              </p>
              <pre className="knowledge-excerpt">{hit.content}</pre>
            </article>
          ))}
        </section>
      )}
      <section aria-label="已导入文档">
        <h3>已导入文档（{documents.length}）</h3>
        {documents.length === 0 && (
          <p>
            导入项目文档、个人笔记或参考资料后，piko
            会在回答相关问题时检索并引用来源。
          </p>
        )}
        {documents.map((doc) => (
          <article className="memory-card" key={doc.id}>
            <h4>
              {doc.title} <small>· {doc.scope || "通用"}</small>
            </h4>
            <p className="knowledge-source">{doc.path}</p>
            <p>
              {doc.chunkCount} 个片段 · 更新于{" "}
              {new Date(doc.updatedAt * 1000).toLocaleString()}
            </p>
            <div className="memory-card__actions">
              <button
                type="button"
                disabled={!!busy || !desktop}
                onClick={() =>
                  void perform("重新索引文件", () =>
                    importPaths([doc.path], doc.scope),
                  )
                }
              >
                重新索引文件
              </button>
              <button
                type="button"
                disabled={!!busy || !desktop}
                onClick={() => {
                  if (
                    !confirm(
                      `从知识库删除“${doc.title}”及其索引？原文件会保留。`,
                    )
                  )
                    return;
                  void perform("删除", async () => {
                    await invoke("knowledge_delete_document", { id: doc.id });
                    setHits([]);
                    setSearched(false);
                    await load();
                  });
                }}
              >
                删除
              </button>
            </div>
          </article>
        ))}
      </section>
      <details>
        <summary>语义检索设置</summary>
        <p className="knowledge-help">
          默认仅使用本地关键词检索。启用语义检索后，会将搜索问题、文档片段及有效用户记忆发送至下方配置的
          Embedding 服务。可使用本机 Ollama 的 OpenAI
          兼容接口，也可配置云端服务。修改模型或资料后需要建立索引；服务不可用时自动使用关键词检索。
        </p>
        <form
          className="knowledge-settings"
          onSubmit={(e) => {
            e.preventDefault();
            void perform("保存设置", async () => {
              const saved = await invoke<Settings>("knowledge_save_settings", {
                input: settings,
                apiKeyUpdate: clearKey ? "" : key || null,
              });
              setSettings(saved);
              setKey("");
              setClearKey(false);
              setDirty(false);
              setMessage("设置已保存。旧向量已清理，请重新建立语义索引。");
            });
          }}
        >
          <label>
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(e) => updateSettings({ enabled: e.target.checked })}
            />
            启用语义检索
          </label>
          <label>
            Embedding 完整接口地址
            <input
              type="url"
              required
              value={settings.endpoint}
              onChange={(e) => updateSettings({ endpoint: e.target.value })}
            />
          </label>
          <label>
            模型名称
            <input
              required
              value={settings.model}
              onChange={(e) => updateSettings({ model: e.target.value })}
            />
          </label>
          <label>
            API Key（可选，保存至系统钥匙串）
            <input
              type="password"
              autoComplete="new-password"
              value={key}
              disabled={clearKey}
              placeholder="留空保留已有密钥"
              onChange={(e) => {
                setKey(e.target.value);
                setDirty(true);
              }}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={clearKey}
              onChange={(e) => {
                setClearKey(e.target.checked);
                setDirty(true);
              }}
            />
            清除已有密钥
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.allowRemote}
              onChange={(e) =>
                updateSettings({ allowRemote: e.target.checked })
              }
            />
            允许将问题、记忆和资料发送到远程 HTTPS Embedding 服务
          </label>
          <button disabled={!!busy || !desktop}>保存设置</button>
        </form>
        <div className="knowledge-toolbar">
          <button
            type="button"
            disabled={!!busy || !desktop || !settings.enabled || dirty}
            onClick={() => void reindex()}
          >
            建立 / 更新语义索引
          </button>
          {busy === "建立索引" && (
            <button
              type="button"
              onClick={() => {
                stop.current = true;
                setMessage("当前批次完成后停止，已建立的索引会保留。");
              }}
            >
              停止后续批次
            </button>
          )}
        </div>
      </details>
    </div>
  );
}
