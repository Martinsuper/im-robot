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
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { initialPetState, reducePetState } from "./features/pet/petState";
import ReactMarkdown from "react-markdown";
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
  const [companionName, setCompanionName] = useState("Piko");
  const isResting = petState.mode === "resting";
  const resetTimer = useRef<number | undefined>(undefined);

  function resetAfter(delay = 1400) {
    if (resetTimer.current) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => dispatch({ type: "RESET" }), delay);
  }

  function showTransient(event: Parameters<typeof dispatch>[0], delay?: number) {
    dispatch(event);
    resetAfter(delay);
  }

  useEffect(() => {
    void runCommand<AppSettings>("get_settings", undefined, defaultAppSettings).then((settings) => {
      setCompanionName(settings.companionName);
    });
  }, []);

  useEffect(() => {
    if (!isTauriRuntime) return;

    const unlisten = listen<ChatEvent>("chat-event", (event) => {
      if (event.payload.type === "started") {
        dispatch({ type: event.payload.working ? "WORK_STARTED" : "CHAT_SUBMITTED" });
      }
      if (event.payload.type === "delta") dispatch({ type: "CHAT_STREAM_STARTED" });
      if (event.payload.type === "completed") showTransient({ type: "CHAT_COMPLETED" });
      if (event.payload.type === "cancelled") dispatch({ type: "RESET" });
      if (event.payload.type === "failed") {
        showTransient({ type: "FAILED", message: event.payload.message }, 2400);
      }
    });

    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime) return;

    const unlisten = listen<PetVisualEvent>("pet-visual-event", (event) => {
      if (event.payload.type === "attachment-ready") {
        showTransient({ type: "ATTACHMENT_READY" }, 2200);
      }
      if (event.payload.type === "reminder-fired") {
        showTransient({ type: "REMINDER_FIRED", message: event.payload.message }, 2600);
      }
    });

    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => () => {
    if (resetTimer.current) window.clearTimeout(resetTimer.current);
  }, []);

  function toggleRest() {
    dispatch({ type: isResting ? "WAKE" : "REST" });
  }

  const DRAG_THRESHOLD_PX = 4;
  const [dragOrigin, setDragOrigin] = useState<{ x: number; y: number } | null>(null);

  return (
    <main
      className="pet-stage"
      aria-label={`桌面精灵 ${companionName}`}
      onMouseDown={(event) => {
        if (!isTauriRuntime) return;
        setDragOrigin({ x: event.screenX, y: event.screenY });
      }}
      onMouseUp={() => setDragOrigin(null)}
      onMouseMove={(event) => {
        if ((event.buttons & 1) === 0 || !isTauriRuntime) return;
        if (!dragOrigin) return;
        const dx = event.screenX - dragOrigin.x;
        const dy = event.screenY - dragOrigin.y;
        if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
        event.preventDefault();
        void runCommand("move_pet", { x: event.screenX - 78, y: event.screenY - 70 });
      }}
    >
      <div
        className={`pet pet--${petState.mode} pet-reaction--${petState.reaction}`}
        aria-label="拖动 Piko"
        onClick={() => {
          if (!isResting) showTransient({ type: "INTERACT" });
        }}
      >
        <PetSprite mode={petState.mode} />
        <span className={`pet-emotion pet-emotion--${petState.emotion}`} aria-hidden="true" />
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
  const [companionName, setCompanionName] = useState("Piko");
  const [isThinking, setIsThinking] = useState(false);
  const [attachment, setAttachment] = useState<AttachmentPreview>();
  const [attachmentAction, setAttachmentAction] = useState<AttachmentAction>("summarize");
  const [attachmentError, setAttachmentError] = useState("");
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [requestId, setRequestId] = useState<string>();
  const activeRequestId = useRef<string | undefined>(undefined);
  const lastSequence = useRef(0);
  const previewReplyTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    void runCommand<AppSettings>("get_settings", undefined, defaultAppSettings).then((settings) => {
      setCompanionName(settings.companionName);
      setMessage(`你好，我是 ${settings.companionName}。今天想一起完成什么？`);
    });
  }, []);

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

  useEffect(() => {
    if (!isTauriRuntime) return;

    const unlisten = getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") {
        setIsDraggingFile(true);
        return;
      }
      setIsDraggingFile(false);
      if (event.payload.type !== "drop") return;
      if (event.payload.paths.length !== 1) {
        setAttachmentError("一次只能处理一个文本文件。");
        return;
      }

      setAttachmentError("");
      void runCommand<AttachmentPreview>("prepare_text_attachment", {
        path: event.payload.paths[0],
      })
        .then(setAttachment)
        .catch((error) => setAttachmentError(String(error)));
    });

    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prompt.trim() && !attachment) return;

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
      attachmentAction: attachment ? attachmentAction : undefined,
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

  async function clearAttachment() {
    await runCommand("clear_text_attachment");
    setAttachment(undefined);
    setAttachmentError("");
  }

  return (
    <main className="bubble-shell">
      <header className="bubble-header">
        <div className="companion-heading">
          <PetSprite mode={isThinking ? "thinking" : "idle"} compact />
          <div>
            <p className="eyebrow">{companionName.toUpperCase()} · QUICK CHAT</p>
            <h1>{isThinking ? "正在思考..." : "今天想做点什么？"}</h1>
          </div>
        </div>
        <button className="close-button" type="button" onClick={() => runCommand("hide_bubble")} aria-label="关闭">
          ×
        </button>
      </header>
      <div className="bubble-message">
        <ReactMarkdown>{message}</ReactMarkdown>
      </div>
      <section className={`attachment-dropzone${isDraggingFile ? " is-dragging" : ""}`}>
        {attachment ? (
          <>
            <div className="attachment-heading">
              <div>
                <strong>{attachment.displayName}</strong>
                <span>
                  {formatBytes(attachment.byteSize)} · {attachment.charCount} 字符
                </span>
              </div>
              <button type="button" onClick={() => void clearAttachment()}>
                移除
              </button>
            </div>
            <p>{attachment.preview || "空文件"}</p>
            <div className="attachment-actions" aria-label="附件处理方式">
              {attachmentActionOptions.map(({ label, value }) => (
                <button
                  className={attachmentAction === value ? "is-active" : ""}
                  key={value}
                  type="button"
                  onClick={() => setAttachmentAction(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </>
        ) : (
          <p>{isDraggingFile ? "松开即可读取文本文件" : "拖入 .txt、.md、.json、.csv 或 .log 文件"}</p>
        )}
        {attachmentError && <span className="attachment-error">{attachmentError}</span>}
      </section>
      <form className="prompt-form" onSubmit={submit}>
        <input
          autoFocus
          value={prompt}
          onChange={(event) => setPrompt(event.currentTarget.value)}
          placeholder={attachment ? "可补充处理要求" : "输入问题，或描述一个任务"}
          aria-label="发送给 Piko 的问题"
        />
        <button type="submit" disabled={(!prompt.trim() && !attachment) || isThinking}>
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
  const [companionName, setCompanionName] = useState("Piko");
  const [theme, setTheme] = useState<Theme>("sage");
  const [sensingPaused, setSensingPaused] = useState(false);
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [preferencesStatus, setPreferencesStatus] = useState("");
  const [notificationPermission, setNotificationPermission] = useState("按需申请");
  const [updateStatus, setUpdateStatus] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("尚未测试连接");
  const [isTesting, setIsTesting] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatHistoryEntry[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [reminderTitle, setReminderTitle] = useState("");
  const [reminderDueAt, setReminderDueAt] = useState(defaultReminderTime);
  const [reminderError, setReminderError] = useState("");
  const statuses = useMemo(
    () => [
      ["桌面精灵", "在线"],
      ["AI 对话", connectionStatus],
      ["文件处理", "可用"],
      ["提醒", "可用"],
    ],
    [connectionStatus],
  );

  useEffect(() => {
    void runCommand<AppSettings>("get_settings", undefined, defaultAppSettings).then((settings) => {
      setQuietMode(settings.quietMode);
      setAiSettings(settings.ai);
      setCompanionName(settings.companionName);
      setTheme(settings.theme);
      setSensingPaused(settings.sensingPaused);
      setConnectionStatus(settings.hasApiKey ? "已配置密钥" : "等待测试");
    });
    void runCommand<ChatHistoryEntry[]>("list_chat_history", undefined, []).then(setChatHistory);
    void runCommand<Reminder[]>("list_reminders", undefined, []).then(setReminders);
    if (isTauriRuntime) {
      void isEnabled().then(setAutostartEnabled);
      void isPermissionGranted().then((granted) => {
        setNotificationPermission(granted ? "已授权" : "按需申请");
      });
    }

    if (!isTauriRuntime) return;
    const unlisten = listen("reminders-updated", () => {
      void runCommand<Reminder[]>("list_reminders", undefined, []).then(setReminders);
    });
    return () => {
      void unlisten.then((dispose) => dispose());
    };
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

  async function createReminder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const dueAt = Math.floor(new Date(reminderDueAt).getTime() / 1000);
    if (!reminderTitle.trim() || !Number.isFinite(dueAt)) return;

    setReminderError("");
    try {
      if (isTauriRuntime && !(await isPermissionGranted())) {
        const permission = await requestPermission();
        if (permission !== "granted") {
          setReminderError("未授予通知权限，提醒会保存，但系统可能无法弹出通知。");
        } else {
          setNotificationPermission("已授权");
        }
      }
      const reminder = await runCommand<Reminder>(
        "create_reminder",
        { input: { title: reminderTitle, dueAt } },
        {
          id: crypto.randomUUID(),
          title: reminderTitle.trim(),
          dueAt,
          status: "pending",
        },
      );
      setReminders((current) => [...current, reminder].sort((left, right) => left.dueAt - right.dueAt));
      setReminderTitle("");
      setReminderDueAt(defaultReminderTime());
    } catch (error) {
      setReminderError(String(error));
    }
  }

  async function deleteReminder(id: string) {
    try {
      await runCommand("delete_reminder", { id });
      setReminders((current) => current.filter((reminder) => reminder.id !== id));
    } catch (error) {
      setReminderError(String(error));
    }
  }

  async function savePreferences() {
    setPreferencesStatus("");
    try {
      const settings = await runCommand<AppSettings>(
        "update_preferences",
        { input: { companionName, theme, sensingPaused } },
        { ...defaultAppSettings, companionName, theme, sensingPaused, ai: aiSettings },
      );
      setCompanionName(settings.companionName);
      setTheme(settings.theme);
      setSensingPaused(settings.sensingPaused);
      setPreferencesStatus("已保存");
    } catch (error) {
      setPreferencesStatus(String(error));
    }
  }

  async function toggleAutostart() {
    try {
      if (autostartEnabled) {
        await disable();
      } else {
        await enable();
      }
      setAutostartEnabled(!autostartEnabled);
    } catch (error) {
      setPreferencesStatus(`开机启动设置失败：${String(error)}`);
    }
  }

  return (
    <main className={`panel-shell panel-shell--${theme}`}>
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
          <h2>{companionName}</h2>
          <p>像素型桌面精灵。擅长陪伴、对话和处理专注任务。</p>
          <div className="trait-list">
            <span>像素系</span>
            <span>AI 助手</span>
          </div>
        </div>
      </section>

      <section className="panel-card">
        <p className="eyebrow">PRIVACY & PERMISSIONS</p>
        <h2>权限中心</h2>
        <div className="permission-list">
          <div><span>通知权限</span><strong>{notificationPermission}</strong></div>
          <div><span>文件访问</span><strong>仅主动拖入</strong></div>
          <div><span>屏幕录制</span><strong>截图功能待接入</strong></div>
          <div><span>主动感知</span><strong>{sensingPaused ? "已暂停" : "未启用持续感知"}</strong></div>
        </div>
      </section>

      <section className="panel-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">ABOUT</p>
            <h2>版本信息</h2>
          </div>
          <button type="button" onClick={() => setUpdateStatus("尚未配置发布源，当前无法联网检查更新。")}>
            检查更新
          </button>
        </div>
        <p className="empty-state">Piko Desktop Companion · v0.1.0</p>
        {updateStatus && <p className="connection-status">{updateStatus}</p>}
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
        <p className="eyebrow">PREFERENCES</p>
        <h2>个性化与系统</h2>
        <div className="settings-form">
          <label>
            <span>精灵名称</span>
            <input
              value={companionName}
              maxLength={24}
              onChange={(event) => setCompanionName(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>主题色</span>
            <select value={theme} onChange={(event) => setTheme(event.currentTarget.value as Theme)}>
              <option value="sage">鼠尾草绿</option>
              <option value="blue">湖水蓝</option>
              <option value="peach">暖桃色</option>
            </select>
          </label>
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={sensingPaused}
              onChange={(event) => setSensingPaused(event.currentTarget.checked)}
            />
            <span>暂停主动感知</span>
          </label>
          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={autostartEnabled}
              onChange={() => void toggleAutostart()}
            />
            <span>开机自动启动</span>
          </label>
          <button type="button" onClick={() => void savePreferences()}>
            保存个性化设置
          </button>
          {preferencesStatus && <p className="connection-status">{preferencesStatus}</p>}
        </div>
      </section>

      <section className="panel-card">
        <p className="eyebrow">REMINDERS</p>
        <h2>提醒事项</h2>
        <form className="reminder-form" onSubmit={createReminder}>
          <input
            value={reminderTitle}
            onChange={(event) => setReminderTitle(event.currentTarget.value)}
            maxLength={120}
            placeholder="例如：起来活动一下"
            aria-label="提醒内容"
          />
          <div>
            <input
              type="datetime-local"
              value={reminderDueAt}
              onChange={(event) => setReminderDueAt(event.currentTarget.value)}
              aria-label="提醒时间"
            />
            <button type="submit" disabled={!reminderTitle.trim() || !reminderDueAt}>
              添加
            </button>
          </div>
        </form>
        {reminderError && <p className="reminder-error">{reminderError}</p>}
        {reminders.length ? (
          <ul className="reminder-list">
            {reminders.map((reminder) => (
              <li key={reminder.id}>
                <div>
                  <strong>{reminder.title}</strong>
                  <span>
                    {formatReminderTime(reminder.dueAt)} ·{" "}
                    {reminder.status === "triggered" ? "已提醒" : "等待中"}
                  </span>
                </div>
                <button type="button" onClick={() => void deleteReminder(reminder.id)}>
                  删除
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">暂无提醒。</p>
        )}
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
  companionName: string;
  theme: Theme;
  sensingPaused: boolean;
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

interface AttachmentPreview {
  displayName: string;
  byteSize: number;
  charCount: number;
  preview: string;
}

interface Reminder {
  id: string;
  title: string;
  dueAt: number;
  status: "pending" | "triggered";
}

type AttachmentAction = "summarize" | "translate" | "explain";
type Theme = "sage" | "blue" | "peach";

type ChatEvent =
  | { type: "started"; requestId: string; working: boolean }
  | { type: "delta"; requestId: string; sequence: number; text: string }
  | { type: "completed"; requestId: string }
  | { type: "cancelled"; requestId: string }
  | { type: "failed"; requestId: string; message: string };

type PetVisualEvent =
  | { type: "attachment-ready" }
  | { type: "reminder-fired"; message: string };

const defaultAiSettings: AiSettings = {
  provider: "openai-compatible",
  baseUrl: "http://localhost:11434/v1",
  model: "gemma4:e4b",
  temperature: 0.7,
  timeoutSeconds: 120,
};

const defaultAppSettings: AppSettings = {
  quietMode: "balanced",
  companionName: "Piko",
  theme: "sage",
  sensingPaused: false,
  ai: defaultAiSettings,
  hasApiKey: false,
};

const quietModeOptions: Array<{ label: string; value: QuietMode }> = [
  { label: "活泼", value: "active" },
  { label: "平衡", value: "balanced" },
  { label: "极简", value: "minimal" },
];

const attachmentActionOptions: Array<{ label: string; value: AttachmentAction }> = [
  { label: "总结", value: "summarize" },
  { label: "翻译", value: "translate" },
  { label: "解释", value: "explain" },
];

function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

function defaultReminderTime() {
  const date = new Date(Date.now() + 10 * 60 * 1000);
  date.setSeconds(0, 0);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

function formatReminderTime(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp * 1000);
}

function App() {
  if (windowLabel === "bubble") return <BubbleWindow />;
  if (windowLabel === "panel") return <PanelWindow />;
  return <PetWindow />;
}

export default App;
