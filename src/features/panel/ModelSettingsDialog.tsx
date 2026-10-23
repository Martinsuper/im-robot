import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, Eye, EyeOff, X } from "lucide-react";
import { ModelPicker } from "./ModelPicker";
import { useAppSettings } from "./settingsStore";
import { findProviderPreset, providerOptions } from "../app/appShared";
import { runCommand } from "../app/appRuntime";
import { toUserMessage } from "../../lib/errors";
import type { AiSettings, AppSettings } from "../../types/appTypes";
import "./modelSettingsDialog.css";

export function ModelSettingsDialog({ onClose, initialTab = "models" }: { onClose: () => void; initialTab?: "models" | "connection" }) {
  const { settings, applyServer } = useAppSettings();
  const [baseline] = useState(settings);
  const [tab, setTab] = useState(initialTab);
  const [draft, setDraft] = useState<AiSettings>(settings.ai);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<"idle" | "connected" | "empty">("idle");
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const description = useId();
  const normalize = (url: string) => url.trim().replace(/\/+$/, "");
  const sameConnection = draft.provider === baseline.ai.provider && normalize(draft.baseUrl) === normalize(baseline.ai.baseUrl);
  const useSavedKey = baseline.hasApiKey && !clearKey && sameConnection;

  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);

  function update<Key extends keyof AiSettings>(key: Key, value: AiSettings[Key]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setError("");
    if (key === "provider" || key === "baseUrl") setConnection("idle");
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    try {
      const url = new URL(draft.baseUrl.trim());
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    } catch {
      setTab("connection");
      setError("请输入有效的 http:// 或 https:// API 地址。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const next = await runCommand("update_ai_settings", {
        input: { ...draft, baseUrl: draft.baseUrl.trim(), model: draft.model.trim(), apiKey: clearKey ? null : apiKey.trim() || (sameConnection ? undefined : null) },
      }, { ...settings, ai: draft, hasApiKey: !clearKey && (!!apiKey.trim() || (sameConnection && baseline.hasApiKey)) });
      applyServer(next as AppSettings);
      onClose();
    } catch (reason) { setError(toUserMessage(reason)); }
    finally { setSaving(false); }
  }

  return createPortal(<dialog ref={dialog} className={`model-settings-dialog panel-shell--${settings.theme}`} aria-labelledby={title} aria-describedby={description}
    onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget || saving) return;
      const box = event.currentTarget.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
    }}>
    <form onSubmit={(event) => void save(event)}>
      <header className="model-settings-dialog__header">
        <div><h2 id={title}>模型与 API</h2><p id={description} className="sr-only">选择模型或配置 API 连接</p></div>
        <button type="button" className="model-settings-dialog__close" aria-label="关闭模型配置" disabled={saving} onClick={onClose}><X size={22} /></button>
      </header>
      <div className="model-settings-dialog__tabs" role="tablist" aria-label="模型配置栏目">
        {(["models", "connection"] as const).map((value) => <button key={value} type="button" role="tab"
          id={`${title}-tab-${value}`} aria-controls={`${title}-panel-${value}`} aria-selected={tab === value}
          tabIndex={tab === value ? 0 : -1} disabled={saving} onClick={() => setTab(value)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? "models" : event.key === "End" ? "connection" : value === "models" ? "connection" : "models";
            setTab(next); document.getElementById(`${title}-tab-${next}`)?.focus();
          }}>{value === "models" ? "选择模型" : "连接配置"}</button>)}
      </div>
      <div className="model-settings-dialog__scroll">
        <div role="tabpanel" id={`${title}-panel-connection`} aria-labelledby={`${title}-tab-connection`} hidden={tab !== "connection"}>
        <fieldset className="model-settings-dialog__connection" disabled={saving || tab !== "connection"}>
          <legend className="sr-only">连接设置</legend>
          <label><span>服务商</span><div className="model-settings-dialog__select">
            <select value={draft.provider} onChange={(event) => {
              const provider = event.currentTarget.value;
              const preset = findProviderPreset(provider);
              setDraft((current) => ({ ...current, provider, baseUrl: preset?.baseUrl ?? "", model: preset?.model ?? "" }));
              setConnection("idle"); setError("");
            }}>{providerOptions.map(({ label, value }) => <option key={value} value={value}>{label}</option>)}</select><ChevronDown size={16} aria-hidden="true" />
          </div></label>
          <label><span>API 地址</span><input type="url" required value={draft.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => update("baseUrl", event.currentTarget.value)} /></label>
          <div className="model-settings-dialog__key-group">
            <label><span>API 密钥</span><div className="model-settings-dialog__key">
              <input type={showKey ? "text" : "password"} value={apiKey} autoComplete="off" spellCheck={false}
                placeholder={clearKey ? "保存后将清除密钥" : useSavedKey ? "已保存密钥，输入可替换" : findProviderPreset(draft.provider)?.needsApiKey === false ? "本地服务可留空" : "输入该服务的 API Key"}
                onChange={(event) => { setApiKey(event.currentTarget.value); setClearKey(false); setConnection("idle"); setError(""); }} />
              <button type="button" aria-label={showKey ? "隐藏密钥" : "显示密钥"} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={18} /> : <Eye size={18} />}</button>
            </div></label>
            <div className="model-settings-dialog__key-note"><small>密钥仅保存在本机。</small>{(useSavedKey || apiKey) && <button type="button" onClick={() => { setApiKey(""); setClearKey(true); setConnection("idle"); }}>清除密钥</button>}</div>
            {!sameConnection && baseline.hasApiKey && <small className="model-settings-dialog__hint">已切换连接，请填写该服务的密钥。</small>}
          </div>
          <details className="model-settings-dialog__advanced"><summary><ChevronRight size={17} />高级设置</summary>
            <div className="model-settings-dialog__advanced-fields">
              {([
                ["temperature", "Temperature", 0, 2, 0.1],
                ["timeoutSeconds", "超时秒数", 5, 600, 1],
                ["contextWindow", "上下文窗口（0 自动）", 0, 2000000, 1],
                ["maxOutputTokens", "最大输出 Token（0 自动）", 0, 200000, 1],
              ] as const).map(([key, label, min, max, step]) => <label key={key}><span>{label}</span><input type="number" min={min} max={max} step={step} value={draft[key] ?? 0} onChange={(event) => update(key, Number(event.currentTarget.value))} /></label>)}
            </div>
          </details>
        </fieldset></div>
        <div role="tabpanel" id={`${title}-panel-models`} aria-labelledby={`${title}-tab-models`} hidden={tab !== "models"}>
        <fieldset className="model-settings-dialog__models" disabled={saving || tab !== "models"}>
        <legend className="sr-only">模型列表</legend>
        <ModelPicker key={JSON.stringify([draft.provider, draft.baseUrl, apiKey, clearKey])} settings={draft} apiKey={apiKey} useSavedKey={useSavedKey} currentModel={sameConnection ? baseline.ai.model : ""}
          onChange={(model) => update("model", model)} onLoadStart={() => setConnection("idle")} onLoaded={(count) => setConnection(count ? "connected" : "empty")} />
      </fieldset></div></div>
      {error && <p role="alert" className="model-settings-dialog__error">{error}</p>}
      {settings.credentialError && <p role="alert" className="model-settings-dialog__error">{settings.credentialError}</p>}
      <footer className="model-settings-dialog__footer">
        <span role="status" className={`model-settings-dialog__status${connection !== "idle" ? " is-connected" : ""}`}>
          <span aria-hidden="true" />{saving ? "正在保存配置…" : connection === "connected" ? "连接正常" : connection === "empty" ? "已连接，未发现模型" : sameConnection && baseline.ai.model ? "已配置" : "尚未验证连接"}
        </span>
        <div><button type="button" className="model-settings-dialog__cancel" disabled={saving} onClick={onClose}>取消</button><button type="submit" className="model-settings-dialog__save" disabled={saving || !draft.model.trim() || !draft.baseUrl.trim()}>{saving ? "保存中…" : "保存并使用"}</button></div>
      </footer>
    </form>
  </dialog>, document.body);
}
