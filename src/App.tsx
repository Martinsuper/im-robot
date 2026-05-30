import { FormEvent, useEffect, useMemo, useReducer, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { initialPetState, reducePetState } from "./features/pet/petState";
import "./App.css";

type WindowLabel = "pet" | "bubble" | "panel";

const isTauriRuntime = "__TAURI_INTERNALS__" in window;

function detectWindowLabel(): WindowLabel {
  if (isTauriRuntime) return getCurrentWindow().label as WindowLabel;

  const preview = new URLSearchParams(window.location.search).get("view");
  return preview === "bubble" || preview === "panel" ? preview : "pet";
}

function runCommand<T>(command: string, args?: Record<string, unknown>, fallback?: T) {
  return isTauriRuntime ? invoke<T>(command, args) : Promise.resolve(fallback as T);
}

const windowLabel = detectWindowLabel();

function PetWindow() {
  const [petState, dispatch] = useReducer(reducePetState, initialPetState);
  const isResting = petState.mode === "resting";

  function toggleRest() {
    dispatch({ type: isResting ? "WAKE" : "REST" });
  }

  return (
    <main className="pet-stage" aria-label="桌面精灵 Piko">
      <button
        className={`pet pet--${petState.mode}`}
        type="button"
        aria-label="打开 Piko 对话气泡"
        onClick={() => {
          dispatch({ type: "LISTEN" });
          void runCommand("show_bubble");
        }}
        onMouseDown={(event) => {
          if (event.button === 0 && isTauriRuntime) void getCurrentWindow().startDragging();
        }}
      >
        <span className="pet__ear pet__ear--left" />
        <span className="pet__ear pet__ear--right" />
        <span className="pet__face">
          <span className="pet__eye pet__eye--left" />
          <span className="pet__eye pet__eye--right" />
          <span className="pet__mouth" />
          <span className="pet__core" />
        </span>
      </button>
      <div className="pet-actions">
        <button
          className="icon-button"
          type="button"
          onClick={toggleRest}
        >
          {isResting ? "Awake" : "Rest"}
        </button>
        <button className="icon-button" type="button" onClick={() => runCommand("open_panel")}>
          Panel
        </button>
      </div>
      <p className="pet-status" aria-live="polite">
        {petState.message}
      </p>
    </main>
  );
}

function BubbleWindow() {
  const [prompt, setPrompt] = useState("");
  const [message, setMessage] = useState("你好，我是 Piko。今天想一起完成什么？");
  const [isThinking, setIsThinking] = useState(false);
  const [requestId, setRequestId] = useState<string>();

  useEffect(() => {
    if (!isTauriRuntime) return;

    const unlisten = listen<ChatEvent>("chat-event", (event) => {
      if (event.payload.requestId !== requestId) return;

      if (event.payload.type === "Started") {
        setMessage("");
      }
      if (event.payload.type === "Delta") {
        const { text } = event.payload;
        setIsThinking(false);
        setMessage((current) => current + text);
      }
      if (event.payload.type === "Completed") {
        setIsThinking(false);
      }
      if (event.payload.type === "Failed") {
        setIsThinking(false);
        setMessage(event.payload.message);
      }
    });

    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, [requestId]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prompt.trim()) return;

    const currentPrompt = prompt.trim();
    const currentRequestId = crypto.randomUUID();
    setIsThinking(true);
    setMessage("Piko 正在连接模型服务...");
    setRequestId(currentRequestId);
    setPrompt("");

    if (!isTauriRuntime) {
      window.setTimeout(() => {
        setMessage(`这是浏览器预览回复：${currentPrompt}`);
        setIsThinking(false);
      }, 450);
      return;
    }

    void runCommand<void>("chat_start", {
      requestId: currentRequestId,
      prompt: currentPrompt,
    }).catch((error) => {
      setIsThinking(false);
      setMessage(`模型服务连接失败：${String(error)}`);
    });
  }

  return (
    <main className="bubble-shell">
      <header className="bubble-header">
        <div>
          <p className="eyebrow">PIKO QUICK CHAT</p>
          <h1>{isThinking ? "正在思考..." : "随时可以问我"}</h1>
        </div>
        <button className="close-button" type="button" onClick={() => runCommand("hide_bubble")}>
          Close
        </button>
      </header>
      <p className="bubble-message">{message}</p>
      <form className="prompt-form" onSubmit={submit}>
        <input
          autoFocus
          value={prompt}
          onChange={(event) => setPrompt(event.currentTarget.value)}
          placeholder="输入问题，或描述一个任务"
          aria-label="发送给 Piko 的问题"
        />
        <button type="submit" disabled={!prompt.trim() || isThinking}>
          发送
        </button>
      </form>
      <footer className="bubble-footer">
        <span>Command/Ctrl + Shift + Space</span>
        <button type="button" onClick={() => runCommand("open_panel")}>
          打开面板
        </button>
      </footer>
    </main>
  );
}

function PanelWindow() {
  const [quietMode, setQuietMode] = useState<QuietMode>("balanced");
  const [aiSettings, setAiSettings] = useState<AiSettings>(defaultAiSettings);
  const [apiKey, setApiKey] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("尚未测试连接");
  const [isTesting, setIsTesting] = useState(false);
  const statuses = useMemo(
    () => [
      ["桌面精灵", "在线"],
      ["AI 对话", connectionStatus],
      ["文件处理", "规划中"],
      ["提醒", "规划中"],
    ],
    [connectionStatus],
  );

  useEffect(() => {
    void runCommand<AppSettings>("get_settings", undefined, defaultAppSettings).then((settings) => {
      setQuietMode(settings.quietMode);
      setAiSettings(settings.ai);
      setConnectionStatus(settings.hasApiKey ? "已配置密钥" : "等待测试");
    });
  }, []);

  function updateQuietMode(mode: QuietMode) {
    setQuietMode(mode);
    void runCommand<AppSettings>("update_quiet_mode", { quietMode: mode }, {
      ...defaultAppSettings,
      quietMode: mode,
      ai: aiSettings,
    });
  }

  function updateAiField<Key extends keyof AiSettings>(key: Key, value: AiSettings[Key]) {
    setAiSettings((current) => ({ ...current, [key]: value }));
  }

  async function saveAiSettings() {
    const settings = await runCommand<AppSettings>(
      "update_ai_settings",
      { input: { ...aiSettings, apiKey: apiKey || undefined } },
      { ...defaultAppSettings, ai: aiSettings },
    );
    setAiSettings(settings.ai);
    setApiKey("");
    return settings;
  }

  async function testConnection() {
    setIsTesting(true);
    setConnectionStatus("正在连接...");
    try {
      await saveAiSettings();
      const models = await runCommand<ModelInfo[]>("list_models", undefined, [
        { id: aiSettings.model },
      ]);
      const modelNames = models.map((model) => model.id).join("、");
      setConnectionStatus(models.length ? `已连接：${modelNames}` : "已连接，未发现模型");
    } catch (error) {
      setConnectionStatus(`连接失败：${String(error)}`);
    } finally {
      setIsTesting(false);
    }
  }

  return (
    <main className="panel-shell">
      <header className="panel-header">
        <div>
          <p className="eyebrow">DESKTOP AI PET</p>
          <h1>Piko 助手面板</h1>
          <p>M1 桌面体验正在运行。精灵位置会在拖动后吸附至边缘并自动保存。</p>
        </div>
        <span className="status-pill">M1 Desktop</span>
      </header>

      <section className="panel-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">SYSTEM STATUS</p>
            <h2>能力状态</h2>
          </div>
          <button type="button" onClick={() => runCommand("show_pet")}>
            显示精灵
          </button>
        </div>
        <div className="status-grid">
          {statuses.map(([label, value]) => (
            <div className="status-item" key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="panel-card">
        <p className="eyebrow">MODEL PROVIDER</p>
        <h2>模型服务</h2>
        <div className="settings-form">
          <label>
            <span>服务类型</span>
            <select
              value={aiSettings.provider}
              onChange={(event) => updateAiField("provider", event.currentTarget.value)}
            >
              <option value="openai-compatible">OpenAI Compatible</option>
            </select>
          </label>
          <label>
            <span>Base URL</span>
            <input
              value={aiSettings.baseUrl}
              onChange={(event) => updateAiField("baseUrl", event.currentTarget.value)}
              placeholder="http://localhost:11434/v1"
            />
          </label>
          <label>
            <span>Model</span>
            <input
              value={aiSettings.model}
              onChange={(event) => updateAiField("model", event.currentTarget.value)}
              placeholder="gemma4:e2b"
            />
          </label>
          <label>
            <span>API Key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.currentTarget.value)}
              placeholder="本地 Ollama 可留空"
            />
          </label>
          <div className="settings-form__row">
            <label>
              <span>Temperature</span>
              <input
                type="number"
                min="0"
                max="2"
                step="0.1"
                value={aiSettings.temperature}
                onChange={(event) => updateAiField("temperature", Number(event.currentTarget.value))}
              />
            </label>
            <label>
              <span>超时秒数</span>
              <input
                type="number"
                min="5"
                max="600"
                value={aiSettings.timeoutSeconds}
                onChange={(event) =>
                  updateAiField("timeoutSeconds", Number(event.currentTarget.value))
                }
              />
            </label>
          </div>
          <button type="button" disabled={isTesting} onClick={testConnection}>
            {isTesting ? "正在测试..." : "保存并测试连接"}
          </button>
          <p className="connection-status">{connectionStatus}</p>
        </div>
      </section>

      <section className="panel-card">
        <p className="eyebrow">PERSONALITY</p>
        <h2>互动活泼度</h2>
        <div className="segmented-control" aria-label="互动活泼度">
          {quietModeOptions.map(({ label, value }) => (
            <button
              className={value === quietMode ? "is-active" : ""}
              key={value}
              type="button"
              onClick={() => updateQuietMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="panel-card">
        <p className="eyebrow">NEXT BUILD</p>
        <h2>下一阶段</h2>
        <ul className="build-list">
          <li>增加权限中心和文本文件拖入</li>
          <li>增加停止生成和对话历史</li>
          <li>扩展 OpenAI Responses API Provider</li>
        </ul>
      </section>
    </main>
  );
}

type QuietMode = "active" | "balanced" | "minimal";

interface AppSettings {
  quietMode: QuietMode;
  ai: AiSettings;
  hasApiKey: boolean;
}

interface AiSettings {
  provider: string;
  baseUrl: string;
  model: string;
  temperature: number;
  timeoutSeconds: number;
}

interface ModelInfo {
  id: string;
}

type ChatEvent =
  | { type: "Started"; requestId: string }
  | { type: "Delta"; requestId: string; text: string }
  | { type: "Completed"; requestId: string }
  | { type: "Failed"; requestId: string; message: string };

const defaultAiSettings: AiSettings = {
  provider: "openai-compatible",
  baseUrl: "http://localhost:11434/v1",
  model: "gemma4:e2b",
  temperature: 0.7,
  timeoutSeconds: 120,
};

const defaultAppSettings: AppSettings = {
  quietMode: "balanced",
  ai: defaultAiSettings,
  hasApiKey: false,
};

const quietModeOptions: Array<{ label: string; value: QuietMode }> = [
  { label: "活泼", value: "active" },
  { label: "平衡", value: "balanced" },
  { label: "极简", value: "minimal" },
];

function App() {
  if (windowLabel === "bubble") return <BubbleWindow />;
  if (windowLabel === "panel") return <PanelWindow />;
  return <PetWindow />;
}

export default App;
