import {
  CSSProperties,
  FormEvent,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
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

const petSpriteStates = {
  idle: { row: 0, frames: 6, duration: 5500 },
  listening: { row: 3, frames: 4, duration: 700 },
  thinking: { row: 8, frames: 6, duration: 1030 },
  speaking: { row: 3, frames: 4, duration: 700 },
  working: { row: 7, frames: 6, duration: 820 },
  success: { row: 4, frames: 5, duration: 840 },
  confirming: { row: 6, frames: 6, duration: 1010 },
  resting: { row: 0, frames: 1, duration: 5500 },
  error: { row: 5, frames: 8, duration: 1220 },
};

function PetSprite({
  mode = "idle",
  compact = false,
}: {
  mode?: keyof typeof petSpriteStates;
  compact?: boolean;
}) {
  const sprite = petSpriteStates[mode];
  const style = {
    "--sprite-row": sprite.row,
    "--sprite-frames": sprite.frames,
    "--sprite-duration": `${sprite.duration}ms`,
  } as CSSProperties;

  return (
    <span className={`pet-sprite-frame${compact ? " pet-sprite-frame--compact" : ""}`}>
      <span className="pet-sprite" style={style} />
    </span>
  );
}

function PetWindow() {
  const [petState, dispatch] = useReducer(reducePetState, initialPetState);
  const isResting = petState.mode === "resting";

  useEffect(() => {
    if (!isTauriRuntime) return;

    const unlisten = listen<ChatEvent>("chat-event", (event) => {
      if (event.payload.type === "started") dispatch({ type: "CHAT_SUBMITTED" });
      if (event.payload.type === "delta") dispatch({ type: "CHAT_STREAM_STARTED" });
      if (event.payload.type === "completed" || event.payload.type === "cancelled") {
        dispatch({ type: "CHAT_COMPLETED" });
      }
      if (event.payload.type === "failed") {
        dispatch({ type: "FAILED", message: event.payload.message });
      }
    });

    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  function toggleRest() {
    dispatch({ type: isResting ? "WAKE" : "REST" });
  }

  return (
    <main
      className="pet-stage"
      aria-label="桌面精灵 Piko"
      onMouseMove={(event) => {
        if ((event.buttons & 1) === 0 || !isTauriRuntime) return;
        event.preventDefault();
        void runCommand("move_pet", { x: event.screenX - 78, y: event.screenY - 70 });
      }}
    >
      <div
        className={`pet pet--${petState.mode}`}
        aria-label="拖动 Piko"
      >
        <PetSprite mode={petState.mode} />
      </div>
      <div className="pet-actions">
        <button
          className="icon-button"
          type="button"
          onClick={() => {
            dispatch({ type: "LISTEN" });
            void runCommand("show_bubble");
          }}
        >
          对话
        </button>
        <button
          className="icon-button"
          type="button"
          onClick={toggleRest}
        >
          {isResting ? "唤醒" : "休息"}
        </button>
        <button className="icon-button" type="button" onClick={() => runCommand("open_panel")}>
          面板
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
  const activeRequestId = useRef<string | undefined>(undefined);
  const lastSequence = useRef(0);
  const previewReplyTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!isTauriRuntime) return;

    const unlisten = listen<ChatEvent>("chat-event", (event) => {
      if (event.payload.requestId !== activeRequestId.current) return;

      if (event.payload.type === "started") {
        lastSequence.current = 0;
        setMessage("");
      }
      if (event.payload.type === "delta") {
        if (event.payload.sequence <= lastSequence.current) return;
        lastSequence.current = event.payload.sequence;
        const { text } = event.payload;
        setIsThinking(false);
        setMessage((current) => current + text);
      }
      if (event.payload.type === "completed") {
        setIsThinking(false);
      }
      if (event.payload.type === "cancelled") {
        setIsThinking(false);
        setMessage((current) => current || "已停止生成。");
      }
      if (event.payload.type === "failed") {
        setIsThinking(false);
        setMessage(event.payload.message);
      }
    });

    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prompt.trim()) return;

    const currentPrompt = prompt.trim();
    const currentRequestId = crypto.randomUUID();
    setIsThinking(true);
    setMessage("Piko 正在连接模型服务...");
    activeRequestId.current = currentRequestId;
    setRequestId(currentRequestId);
    setPrompt("");

    if (!isTauriRuntime) {
      previewReplyTimer.current = window.setTimeout(() => {
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

  function cancel() {
    if (!requestId) return;
    if (!isTauriRuntime && previewReplyTimer.current) {
      window.clearTimeout(previewReplyTimer.current);
      previewReplyTimer.current = undefined;
      setIsThinking(false);
      setMessage("已停止生成。");
      return;
    }
    void runCommand("chat_cancel", { requestId });
  }

  async function copyResult() {
    await navigator.clipboard.writeText(message);
  }

  return (
    <main className="bubble-shell">
      <header className="bubble-header">
        <div className="companion-heading">
          <PetSprite mode={isThinking ? "thinking" : "idle"} compact />
          <div>
            <p className="eyebrow">PIKO · QUICK CHAT</p>
            <h1>{isThinking ? "正在思考..." : "今天想做点什么？"}</h1>
          </div>
        </div>
        <button className="close-button" type="button" onClick={() => runCommand("hide_bubble")} aria-label="关闭">
          ×
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
        <span>⌘ / Ctrl + Shift + Space</span>
        <div className="bubble-footer__actions">
          {isThinking && (
            <button type="button" onClick={cancel}>
              停止生成
            </button>
          )}
          <button type="button" disabled={!message} onClick={() => void copyResult()}>
            复制结果
          </button>
          <button type="button" onClick={() => runCommand("open_panel")}>
            打开面板
          </button>
        </div>
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
  const [chatHistory, setChatHistory] = useState<ChatHistoryEntry[]>([]);
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
    void runCommand<ChatHistoryEntry[]>("list_chat_history", undefined, []).then(setChatHistory);
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

  async function clearChatHistory() {
    await runCommand("clear_chat_history");
    setChatHistory([]);
  }

  return (
    <main className="panel-shell">
      <header className="panel-header">
        <div>
          <p className="eyebrow">PIKO · DESKTOP COMPANION</p>
          <h1>伙伴图鉴</h1>
          <p>一个安静待在桌面上，也会认真帮忙的小伙伴。</p>
        </div>
        <span className="status-pill">在线</span>
      </header>

      <section className="companion-card">
        <div className="companion-card__portrait">
          <PetSprite />
        </div>
        <div className="companion-card__copy">
          <p className="eyebrow">NO. 001 · DESKTOP SPIRIT</p>
          <h2>Piko</h2>
          <p>像素型桌面精灵。擅长陪伴、对话和处理专注任务。</p>
          <div className="trait-list">
            <span>像素系</span>
            <span>AI 助手</span>
          </div>
        </div>
      </section>

      <section className="panel-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">STATUS</p>
            <h2>当前状态</h2>
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
              placeholder="gemma4:e4b"
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
        <div className="section-heading">
          <div>
            <p className="eyebrow">CHAT HISTORY</p>
            <h2>最近对话</h2>
          </div>
          <button type="button" disabled={!chatHistory.length} onClick={() => void clearChatHistory()}>
            清除历史
          </button>
        </div>
        {chatHistory.length ? (
          <ul className="history-list">
            {chatHistory.map((entry) => (
              <li key={entry.id}>
                <strong>{entry.prompt}</strong>
                <span>{entry.response || "没有返回文本"}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">暂无对话历史。</p>
        )}
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

interface ChatHistoryEntry {
  id: string;
  prompt: string;
  response: string;
  createdAt: number;
}

type ChatEvent =
  | { type: "started"; requestId: string }
  | { type: "delta"; requestId: string; sequence: number; text: string }
  | { type: "completed"; requestId: string }
  | { type: "cancelled"; requestId: string }
  | { type: "failed"; requestId: string; message: string };

const defaultAiSettings: AiSettings = {
  provider: "openai-compatible",
  baseUrl: "http://localhost:11434/v1",
  model: "gemma4:e4b",
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
