import { useEffect, useState } from "react";
import { isTauriRuntime, runCommand } from "../app/appRuntime";
import type { T_tts_SpeechOutputStatus_Output as SpeechOutputStatus } from "../../generated/ipc";
import { toUserMessage } from "../../lib/errors";

export function SpeechOutputSettings() {
  const [settings, setSettings] = useState<SpeechOutputStatus | null>(null);
  const [provider, setProvider] = useState("system");
  const [voice, setVoice] = useState("冰糖");
  const [style, setStyle] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!isTauriRuntime) return;
    let alive = true;
    void runCommand("get_speech_output_settings")
      .then((s) => {
        if (!alive) return;
        setSettings(s);
        setProvider(s.provider);
        setVoice(s.voice);
        setStyle(s.style);
      })
      .catch((e) => {
        if (alive) setError(toUserMessage(e));
      });
    return () => {
      alive = false;
    };
  }, []);
  async function save(preview = false, clear = false) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await runCommand("update_speech_output_settings", {
        input: {
          provider: clear ? "system" : provider,
          voice,
          style,
          apiKey: clear ? "" : apiKey.trim() || null,
        },
      });
      setSettings(next);
      setProvider(next.provider);
      setApiKey("");
      setNotice(
        clear ? "已删除 MiMo 密钥，恢复系统音色。" : "语音输出设置已保存。",
      );
      if (preview) {
        setNotice("正在生成并播放试听…");
        const finished = await runCommand("speak_local_text", {
          text: "你好，我是 Piko。今天辛苦了，先喝口水，放松一下。准备好了，我们就开始专注，好吗？",
        });
        setNotice(finished ? "试听播放完成。" : "正在播放试听。");
      }
    } catch (e) {
      const message = toUserMessage(e);
      if (message.includes("已取消朗读")) setNotice("已停止试听。");
      else setError(message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="settings-subgroup">
      <summary>语音输出与音色</summary>
      <div
        className="settings-subgroup__body speech-output-settings"
        aria-label="语音输出设置"
      >
        <p className="settings-note">
          同时用于电脑朗读和 Passport 设备回复。语音识别继续使用本地
          SenseVoice。
        </p>
        <label className="field-label">
          语音服务
          <select
            aria-label="语音服务"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            disabled={busy || !settings}
          >
            <option value="system">系统语音（离线）</option>
            <option value="mimo">小米 MiMo 云端语音</option>
          </select>
        </label>
        {provider === "mimo" && (
          <>
            <p className="settings-note">
              播报文字将发送至小米
              MiMo；录音和密钥不会发送到设备。当前官方标注限时免费，后续按官方政策执行。
            </p>
            <label className="field-label">
              MiMo API Key
              <input
                aria-label="MiMo API Key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  settings?.hasApiKey
                    ? "已安全保存；留空保留现有密钥"
                    : "填写 MiMo 控制台的 API Key"
                }
                disabled={busy}
              />
            </label>
            <p className="settings-note">
              单独保存在本机密钥文件中，不影响聊天模型密钥。
            </p>
            <label className="field-label">
              音色
              <select
                aria-label="音色"
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
                disabled={busy}
              >
                <option value="冰糖">冰糖 · 中文女声</option>
                <option value="茉莉">茉莉 · 中文女声</option>
                <option value="苏打">苏打 · 中文男声</option>
                <option value="白桦">白桦 · 中文男声</option>
                <option value="mimo_default">MiMo 默认</option>
                <option value="Mia">Mia · 英文女声</option>
                <option value="Chloe">Chloe · 英文女声</option>
                <option value="Milo">Milo · 英文男声</option>
                <option value="Dean">Dean · 英文男声</option>
              </select>
            </label>
            <label className="field-label">
              语气与风格
              <textarea
                aria-label="语气与风格"
                value={style}
                maxLength={500}
                rows={3}
                onChange={(e) => setStyle(e.target.value)}
                disabled={busy}
              />
            </label>
            <p className="settings-note">
              例如：像熟悉的朋友一样温柔自然地说话，语速适中，避免播音腔。单次播报最多40秒。
            </p>
          </>
        )}
        <div className="settings-actions">
          <button
            type="button"
            disabled={busy || !settings}
            onClick={() => void save()}
          >
            保存语音设置
          </button>
          <button
            type="button"
            className="button-secondary"
            disabled={busy || !settings}
            onClick={() => void save(true)}
          >
            保存并试听
          </button>
          <button
            type="button"
            className="button-secondary"
            disabled={!settings}
            onClick={() => {
              void runCommand("stop_local_speech")
                .then(() => setNotice("已停止试听。"))
                .catch((e) => setError(toUserMessage(e)));
            }}
          >
            停止试听
          </button>
          {settings?.hasApiKey && (
            <button
              type="button"
              className="button-secondary"
              disabled={busy}
              onClick={() => void save(false, true)}
            >
              删除 MiMo 密钥
            </button>
          )}
        </div>
        {!isTauriRuntime && <p>请在桌面客户端中配置语音服务。</p>}
        {notice && <p role="status">{notice}</p>}
        {error && <p role="alert">{error}</p>}
      </div>
    </details>
  );
}
