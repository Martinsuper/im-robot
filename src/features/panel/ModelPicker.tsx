import { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, Plus, RefreshCw, Search, Server } from "lucide-react";
import { runCommand } from "../app/appRuntime";
import { toUserMessage } from "../../lib/errors";
import type { AiSettings } from "../../types/appTypes";
import { findProviderPreset } from "../app/providerPresets";

type Props = {
  settings: AiSettings;
  apiKey: string;
  useSavedKey: boolean;
  onChange: (model: string) => void;
  onLoaded?: (count: number) => void;
  onLoadStart?: () => void;
  currentModel?: string;
};

// Only model identifiers are cached. Credentials never enter browser storage.
const cacheKey = (provider: string, url: string) =>
  `piko-model-list:${JSON.stringify([provider, url.trim().replace(/\/+$/, "")])}`;

function readModels(key: string): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? "null");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && !!id.trim()) : [];
  } catch { return []; }
}

export function ModelPicker({ settings, apiKey, useSavedKey, onChange, onLoaded, onLoadStart, currentModel }: Props) {
  const { provider, baseUrl, model } = settings;
  const key = cacheKey(provider, baseUrl);
  const [result, setResult] = useState<{ key: string; models: string[] }>({ key, models: readModels(key) });
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState(false);
  const [manualDraft, setManualDraft] = useState(model);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const generation = useRef(0);
  const models = result.key === key ? result.models : [];
  const ready = /^https?:\/\/[^\s/]+/i.test(baseUrl.trim()) &&
    (!!apiKey.trim() || useSavedKey || ["ollama", "lmstudio", "openai-compatible"].includes(provider));

  async function fetchModels() {
    const request = ++generation.current;
    setBusy(true);
    setError("");
    onLoadStart?.();
    try {
      const response = await runCommand("list_models", {
        input: { provider, baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || null, useSavedKey },
      }, []);
      if (generation.current !== request) return;
      const ids = [...new Set(response.map(({ id }) => id.trim()).filter(Boolean))].sort();
      setResult({ key, models: ids });
      setLoaded(true);
      onLoaded?.(ids.length);
      try { window.localStorage.setItem(key, JSON.stringify(ids)); } catch { /* Selection works without storage. */ }
    } catch (reason) {
      if (generation.current === request) setError(toUserMessage(reason));
    } finally {
      if (generation.current === request) setBusy(false);
    }
  }

  // Debounce credential/address edits, and ignore responses from an older connection.
  useEffect(() => {
    const requests = generation;
    const timer = ready && (!readModels(key).length || apiKey.trim())
      ? window.setTimeout(() => { void fetchModels(); }, 700) : undefined;
    return () => { window.clearTimeout(timer); requests.current++; };
    // Model selection must not trigger another network request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, apiKey, useSavedKey, ready]);

  const available = [...new Set([currentModel ?? model, ...models, model].filter(Boolean))];
  const visible = available.filter((id) => id.toLowerCase().includes(query.trim().toLowerCase()));
  function addManualModel() {
    const id = manualDraft.trim();
    if (!id) return;
    const ids = [...new Set([...models, id])].sort();
    setResult({ key, models: ids });
    try { window.localStorage.setItem(key, JSON.stringify(ids)); } catch { /* Keep selection usable without storage. */ }
    onChange(id);
    setQuery("");
    setManual(false);
  }
  return (
    <section className="model-picker" aria-label="选择模型">
      <div className="model-picker__heading">
        <p>{findProviderPreset(provider)?.label || provider}<span aria-hidden="true"> · </span><span>{models.length} 个模型</span></p>
        <button type="button" className="model-picker__refresh" title="刷新模型列表" aria-label={busy ? "获取中…" : models.length ? "刷新模型" : "获取模型"} disabled={!ready || busy} onClick={() => void fetchModels()}>
          {busy ? <LoaderCircle size={21} className="model-picker__spinner" /> : <RefreshCw size={21} />}
          <span>刷新</span>
        </button>
      </div>
      <label className="model-picker__search">
        <span className="sr-only">搜索模型</span>
        <Search size={19} aria-hidden="true" />
        <input type="search" placeholder="搜索模型" value={query} onChange={(event) => setQuery(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} />
      </label>
      <div className="model-picker__surface">
        <div className="model-picker__list" role="radiogroup" aria-label="可用模型" aria-busy={busy}>
          {visible.map((id) => <label key={id} className={`model-picker__row${id === model ? " is-selected" : ""}`}>
            <input type="radio" name="available-model" value={id} aria-label={id} checked={id === model} onChange={() => { onChange(id); setManual(false); }} />
            <span title={id}>{id}</span>{id === currentModel && <small>当前使用</small>}{id === model && <Check size={16} aria-hidden="true" />}
          </label>)}
          {!visible.length && <div className="model-picker__empty"><Server size={26} strokeWidth={1.5} /><p>{query ? "没有匹配的模型" : busy ? "正在获取模型…" : "暂无可用模型"}</p><small>{query ? "试试其他关键词，或手动添加" : "填写连接信息后获取，也可手动添加"}</small></div>}
        </div>
        <div className="model-picker__bottom">
          {manual && <div className="model-picker__manual"><label><span>模型名称</span><input autoFocus value={manualDraft} placeholder="输入服务支持的模型 ID" onChange={(event) => setManualDraft(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addManualModel(); } }} /></label><button type="button" className="model-picker__add" disabled={!manualDraft.trim()} onClick={addManualModel}>添加模型</button></div>}
          <button type="button" className="model-picker__add" aria-expanded={manual} onClick={() => { setManualDraft(model); setManual(!manual); }}><Plus size={18} />{manual ? "收起输入" : "手动添加"}</button>
        </div>
      </div>
      <small className={`model-picker__feedback${error ? " is-error" : ""}`} role="status" aria-live="polite">
        {busy ? "正在获取可用模型…" : error ? `获取失败：${error}。可重试或手动添加。` : models.length ? `${models.length} 个模型 · 已缓存，可刷新` : loaded ? "服务未返回模型，可手动添加。" : ready ? "模型列表将自动获取" : "填写 API 地址和密钥后自动获取模型。"}
      </small>
    </section>
  );
}
