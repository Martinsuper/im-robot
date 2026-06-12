import { FormEvent, isValidElement, type PointerEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { ActionConfirmationCard, getConfirmationChoices } from "./ActionConfirmationCard";
import { getBubbleCompanionMessage } from "./bubbleMessage";
import type { ActionDraft, ActionExecution, ChatEvent } from "./chatTypes";
import type { AttachmentAction, AttachmentPreview, AppSettings, ChatHistoryEntry, ScreenshotPreview, Theme } from "../../types/appTypes";
import { PetSprite, attachmentActionOptions, defaultAppSettings, formatBytes } from "../app/appShared";
import { isTauriRuntime, runCommand } from "../app/appRuntime";
import { extractHtmlPreviewSource, HtmlPreviewFrame } from "./HtmlPreviewFrame";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";

function extractMarkdownText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractMarkdownText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return extractMarkdownText(node.props.children);
  return "";
}

function textForSpeech(text: string) {
  return text
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{1F1E6}-\u{1F1FF}‍︎️⃣]/gu, "");
}

function MarkdownContent({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        a: ({ children: linkText, href }) => {
          const isSafe = Boolean(href && /^https?:\/\//i.test(href));
          return (
            <a
              href={isSafe ? href : undefined}
              onClick={(event) => {
                event.preventDefault();
                if (isSafe && href) void openUrl(href);
              }}
              rel="noreferrer"
            >
              {linkText}
            </a>
          );
        },
        img: ({ alt, src }) => <img className="markdown-image" alt={alt ?? ""} src={src} />,
        pre: ({ children: code }) => (
          <div className="markdown-code-block">
            <button
              type="button"
              onClick={() => void navigator.clipboard.writeText(extractMarkdownText(code).replace(/\n$/, ""))}
            >
              复制代码
            </button>
            <pre>{code}</pre>
          </div>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function truncate(text: string, max: number): string {
  const cleaned = text.replace(/\n+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

// --- Sub-components ---

function InlineToolbar({
  message,
  isSpeaking,
  copyFeedback,
  htmlPreviewEnabled,
  onCopy,
  onSpeech,
  onSave,
  onUpdateHtmlPreview,
  onClearContext,
  onOpenPanel,
}: {
  message: string;
  isSpeaking: boolean;
  copyFeedback: boolean;
  htmlPreviewEnabled: boolean;
  onCopy: () => void;
  onSpeech: () => void;
  onSave: () => void;
  onUpdateHtmlPreview: (enabled: boolean) => void;
  onClearContext: () => void;
  onOpenPanel: () => void;
}) {
  if (!message.trim()) return null;
  return (
    <div className="inline-toolbar">
      <button
        type="button"
        className={`inline-toolbar__btn${copyFeedback ? " inline-toolbar__btn--feedback" : ""}`}
        onClick={onCopy}
        title="复制结果"
      >
        {copyFeedback ? "✓" : "📋"}
      </button>
      <button
        type="button"
        className={`inline-toolbar__btn${isSpeaking ? " inline-toolbar__btn--active" : ""}`}
        onClick={onSpeech}
        title={isSpeaking ? "停止朗读" : "朗读回复"}
      >
        {isSpeaking ? "🔊⏹" : "🔊"}
      </button>
      <button type="button" className="inline-toolbar__btn" onClick={onSave} title="保存回复">
        💾
      </button>
      <details className="inline-more-menu" data-no-drag>
        <summary className="inline-toolbar__btn" title="更多">⋯</summary>
        <div>
          <button
            type="button"
            className={htmlPreviewEnabled ? "is-active" : ""}
            onClick={() => onUpdateHtmlPreview(!htmlPreviewEnabled)}
          >
            HTML 预览
          </button>
          <button type="button" onClick={onClearContext}>
            清空上下文
          </button>
          <button type="button" onClick={onOpenPanel}>
            打开面板
          </button>
        </div>
      </details>
    </div>
  );
}

function HistoryItem({
  entry,
  isExpanded,
  onToggle,
}: {
  entry: ChatHistoryEntry;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`bubble-thread__history-item${isExpanded ? " bubble-thread__history-item--expanded" : ""}`}>
      <button type="button" className="bubble-thread__history-toggle" onClick={onToggle}>
        <span className="bubble-thread__history-arrow">{isExpanded ? "▾" : "▸"}</span>
        <span className="bubble-thread__history-prompt">{truncate(entry.prompt, 30)}</span>
        <span className="bubble-thread__history-time">{formatTime(entry.createdAt)}</span>
      </button>
      {isExpanded ? (
        <div className="bubble-thread__history-body">
          <div className="bubble-thread__user-bubble bubble-thread__user-bubble--history">
            {entry.prompt}
          </div>
          <div className="bubble-thread__ai-card bubble-thread__ai-card--history">
            <div className="bubble-thread__ai-sprite">
              <PetSprite mode="idle" compact />
            </div>
            <div className="bubble-thread__ai-content">
              <MarkdownContent>{entry.response}</MarkdownContent>
            </div>
          </div>
          <div className="inline-toolbar">
            <button
              type="button"
              className="inline-toolbar__btn"
              onClick={() => void navigator.clipboard.writeText(entry.response)}
              title="复制"
            >
              📋
            </button>
            <button
              type="button"
              className="inline-toolbar__btn"
              onClick={() => {
                if (!("speechSynthesis" in window)) return;
                const spoken = textForSpeech(entry.response).trim();
                if (!spoken) return;
                window.speechSynthesis.cancel();
                const utterance = new SpeechSynthesisUtterance(spoken);
                utterance.lang = "zh-CN";
                window.speechSynthesis.speak(utterance);
              }}
              title="朗读"
            >
              🔊
            </button>
          </div>
        </div>
      ) : (
        <p className="bubble-thread__history-response">
          ↳ {truncate(entry.response, 40)}
        </p>
      )}
    </div>
  );
}

function WelcomeState({ companionName, message }: { companionName: string; message: string }) {
  return (
    <div className="bubble-welcome">
      <PetSprite mode="idle" />
      <p className="bubble-welcome__greeting">
        {message || `你好，我是 ${companionName}。今天想一起完成什么？`}
      </p>
    </div>
  );
}

// --- Main Component ---

export function BubbleWindow() {
  const [prompt, setPrompt] = useState("");
  const [message, setMessage] = useState("");
  const [companionName, setCompanionName] = useState("Piko");
  const [theme, setTheme] = useState<Theme>("sage");
  const [htmlPreviewEnabled, setHtmlPreviewEnabled] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [attachment, setAttachment] = useState<AttachmentPreview>();
  const [attachmentAction, setAttachmentAction] = useState<AttachmentAction>("summarize");
  const [attachmentError, setAttachmentError] = useState("");
  const [screenshot, setScreenshot] = useState<ScreenshotPreview>();
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [speechError, setSpeechError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [contextNotice, setContextNotice] = useState("");
  const [requestId, setRequestId] = useState<string>();
  const [pendingAction, setPendingAction] = useState<ActionDraft>();
  const [selectedChoiceIndexes, setSelectedChoiceIndexes] = useState<number[]>([]);
  const [pendingPromptSummary, setPendingPromptSummary] = useState({ length: 0, hasAttachment: false, hasScreenshot: false });
  const [showReplySkeleton, setShowReplySkeleton] = useState(false);
  const [memoryActivity, setMemoryActivity] = useState<string>("");
  const [isReplyEntering, setIsReplyEntering] = useState(false);
  // New state for redesign
  const [chatHistory, setChatHistory] = useState<ChatHistoryEntry[]>([]);
  const [expandedHistoryIds, setExpandedHistoryIds] = useState<Set<string>>(new Set());
  const [currentPrompt, setCurrentPrompt] = useState("");
  const [copyFeedback, setCopyFeedback] = useState(false);
  const hasInputContext = Boolean(attachment || screenshot || attachmentError || isDraggingFile);
  const activeRequestId = useRef<string | undefined>(undefined);
  const lastSequence = useRef(0);
  const mountedRef = useRef(true);
  const previewReplyTimer = useRef<number | undefined>(undefined);
  const skeletonHideTimer = useRef<number | undefined>(undefined);
  const receivedFirstDelta = useRef(false);
  const threadScrollRef = useRef<HTMLDivElement>(null);
  const confirmationChoices = pendingAction ? getConfirmationChoices(pendingAction) : [];
  const skeletonLineCount = pendingPromptSummary.length > 80 ? 4 : pendingPromptSummary.length > 24 ? 3 : 2;
  const skeletonLines = Array.from({ length: skeletonLineCount }, (_, index) => {
    if (index === 0) return "bubble-skeleton__line--wide";
    if (index === skeletonLineCount - 1) return "bubble-skeleton__line--short";
    return "bubble-skeleton__line--medium";
  });
  const skeletonLabel = pendingPromptSummary.hasAttachment
    ? "正在分析附件并生成回复"
    : pendingPromptSummary.hasScreenshot
      ? "正在分析截图并生成回复"
      : "正在生成回复";

  const topbarStatus = useMemo(() => {
    if (memoryActivity) return { label: memoryActivity, pulse: false };
    if (isSpeaking) return { label: "朗读中", pulse: false };
    if (isThinking) return { label: "思考中…", pulse: true };
    return { label: "在线", pulse: false };
  }, [isThinking, isSpeaking, memoryActivity]);

  const hasCurrentTurn = Boolean(currentPrompt || message || pendingAction || showReplySkeleton);
  const showWelcome = !hasCurrentTurn && chatHistory.length === 0;

  function startBubbleDrag(event: PointerEvent<HTMLElement>) {
    if (!isTauriRuntime || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, textarea, select, a, [data-no-drag]")) return;
    void getCurrentWindow().startDragging();
  }

  function clearSkeletonHideTimer() {
    if (skeletonHideTimer.current) {
      window.clearTimeout(skeletonHideTimer.current);
      skeletonHideTimer.current = undefined;
    }
  }

  function hideSkeletonSoon() {
    clearSkeletonHideTimer();
    skeletonHideTimer.current = window.setTimeout(() => {
      setShowReplySkeleton(false);
      setIsReplyEntering(false);
      skeletonHideTimer.current = undefined;
    }, 220);
  }

  function refreshChatHistory() {
    if (!isTauriRuntime) return;
    void runCommand<ChatHistoryEntry[]>("get_bubble_chat_history", undefined, []).then((entries) => {
      if (entries) setChatHistory(entries);
    });
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    void runCommand<AppSettings>("get_settings", undefined, defaultAppSettings).then((settings) => {
      setCompanionName(settings.companionName);
      setTheme(settings.theme);
      setHtmlPreviewEnabled(settings.htmlPreviewEnabled);
    });
    refreshChatHistory();
  }, []);

  useEffect(() => {
    return () => {
      window.speechSynthesis?.cancel();
      if (isTauriRuntime) void runCommand("stop_local_speech");
      clearSkeletonHideTimer();
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime) return;
    const unlisten = listen<AppSettings>("settings-updated", (event) => {
      setCompanionName(event.payload.companionName);
      setTheme(event.payload.theme);
      setHtmlPreviewEnabled(event.payload.htmlPreviewEnabled);
    });
    return () => {
      void unlisten.then((dispose) => {
        if (mountedRef.current) dispose();
      });
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime) return;
    const refreshScreenshot = () => {
      void runCommand<ScreenshotPreview | null>("get_screen_capture_preview", undefined, null)
        .then((preview) => setScreenshot(preview ?? undefined));
    };
    refreshScreenshot();
    const unlisten = listen<ScreenshotPreview>("screenshot-ready", (event) => {
      setScreenshot(event.payload);
    });
    const unlistenFocus = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) refreshScreenshot();
    });
    return () => {
      void unlisten.then((dispose) => {
        if (mountedRef.current) dispose();
      });
      void unlistenFocus.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime) return;

    const unlisten = listen<ChatEvent>("chat-event", (event) => {
      if (event.payload.requestId !== activeRequestId.current) return;

      if (event.payload.type === "started") {
        lastSequence.current = 0;
        receivedFirstDelta.current = false;
        setMessage("");
        setShowReplySkeleton(true);
        setIsReplyEntering(false);
      }
      if (event.payload.type === "delta") {
        if (event.payload.sequence <= lastSequence.current) return;
        lastSequence.current = event.payload.sequence;
        const { text } = event.payload;
        setIsThinking(false);
        if (!receivedFirstDelta.current) {
          receivedFirstDelta.current = true;
          setIsReplyEntering(true);
          hideSkeletonSoon();
        }
        setMessage((current) => current + text);
      }
      if (event.payload.type === "completed") {
        setIsThinking(false);
        clearSkeletonHideTimer();
        setShowReplySkeleton(false);
        setIsReplyEntering(false);
        refreshChatHistory();
      }
      if (event.payload.type === "action-proposed") {
        setIsThinking(false);
        clearSkeletonHideTimer();
        setShowReplySkeleton(false);
        setIsReplyEntering(false);
        setPendingAction(event.payload.draft);
        setSelectedChoiceIndexes(getConfirmationChoices(event.payload.draft).map((choice) => choice.index));
      }
      if (event.payload.type === "cancelled") {
        setIsThinking(false);
        clearSkeletonHideTimer();
        setShowReplySkeleton(false);
        setIsReplyEntering(false);
        setMessage((current) => current || "已停止生成。");
        refreshChatHistory();
      }
      if (event.payload.type === "failed") {
        setIsThinking(false);
        clearSkeletonHideTimer();
        setShowReplySkeleton(false);
        setIsReplyEntering(false);
        setMessage(event.payload.message);
      }
    });

    return () => {
      void unlisten.then((dispose) => {
        if (mountedRef.current) dispose();
      });
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime) return;
    const unlisten = listen<{ confirmed: number; pending: number }>("memory-captured", (event) => {
      const { confirmed, pending } = event.payload;
      if (pending > 0) {
        setMemoryActivity(`💡 有 ${pending} 条记忆待确认`);
      } else if (confirmed > 0) {
        setMemoryActivity(`💡 已记住 ${confirmed} 条`);
      }
      const timer = window.setTimeout(() => setMemoryActivity(""), 4000);
      return () => window.clearTimeout(timer);
    });
    return () => {
      void unlisten.then((dispose) => {
        if (mountedRef.current) dispose();
      });
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
      void unlisten.then((dispose) => {
        if (mountedRef.current) dispose();
      });
    };
  }, []);

  // Auto-scroll thread to bottom when new messages arrive
  useEffect(() => {
    const el = threadScrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [message, showReplySkeleton, currentPrompt, chatHistory.length]);

  async function sendPrompt(currentPromptValue: string) {
    if (!currentPromptValue.trim() && !attachment && !screenshot) return;

    const requestPrompt = currentPromptValue.trim();
    const currentRequestId = crypto.randomUUID();
    setCurrentPrompt(requestPrompt);
    setIsThinking(true);
    setPendingAction(undefined);
    setSelectedChoiceIndexes([]);
    setMessage("");
    setShowReplySkeleton(true);
    setIsReplyEntering(false);
    receivedFirstDelta.current = false;
    clearSkeletonHideTimer();
    setPendingPromptSummary({
      length: requestPrompt.length,
      hasAttachment: Boolean(attachment),
      hasScreenshot: Boolean(screenshot),
    });
    setContextNotice("");
    activeRequestId.current = currentRequestId;
    setRequestId(currentRequestId);
    setPrompt("");

    if (!isTauriRuntime) {
      previewReplyTimer.current = window.setTimeout(() => {
        previewReplyTimer.current = undefined;
        setMessage(`这是浏览器预览回复：${requestPrompt}`);
        setIsThinking(false);
        clearSkeletonHideTimer();
        setShowReplySkeleton(false);
        setIsReplyEntering(false);
      }, 450);
      return;
    }

    void runCommand<void>("chat_start", {
      input: {
        requestId: currentRequestId,
        prompt: requestPrompt,
        attachmentAction: attachment ? attachmentAction : undefined,
        includeScreenshot: Boolean(screenshot),
      },
    }).catch((error) => {
      setIsThinking(false);
      setMessage(`模型服务连接失败：${String(error)}`);
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!prompt.trim() && !attachment && !screenshot) return;
    const currentPromptValue = prompt.trim();
    void sendPrompt(currentPromptValue);
  }

  function cancel() {
    if (!requestId) return;
    if (!isTauriRuntime && previewReplyTimer.current) {
      window.clearTimeout(previewReplyTimer.current);
      previewReplyTimer.current = undefined;
      clearSkeletonHideTimer();
      setShowReplySkeleton(false);
      setIsReplyEntering(false);
      setIsThinking(false);
      setMessage("已停止生成。");
      return;
    }
    void runCommand("chat_cancel", { requestId });
  }

  async function copyResult() {
    await navigator.clipboard.writeText(message);
    setCopyFeedback(true);
    window.setTimeout(() => setCopyFeedback(false), 1200);
  }

  async function confirmAction() {
    if (!pendingAction) return;
    setSaveError("");
    try {
      if (pendingAction.pluginId === "piko.reminders" && isTauriRuntime && !(await isPermissionGranted())) {
        await requestPermission();
      }
      const execution = await runCommand<ActionExecution>("confirm_chat_action", {
        id: pendingAction.id,
        selectedIndexes: confirmationChoices.length ? selectedChoiceIndexes : undefined,
      });
      setPendingAction(undefined);
      setSelectedChoiceIndexes([]);
      setMessage(execution.message);
      if (isTauriRuntime) {
        const followUpRequestId = crypto.randomUUID();
        activeRequestId.current = followUpRequestId;
        setRequestId(followUpRequestId);
        setIsThinking(true);
        setShowReplySkeleton(true);
        setIsReplyEntering(false);
        receivedFirstDelta.current = false;
        clearSkeletonHideTimer();
        await runCommand<void>("chat_start", {
          input: {
            requestId: followUpRequestId,
            prompt: execution.followUpPrompt,
          },
        });
      }
    } catch (error) {
      setSaveError(String(error));
    }
  }

  async function rejectAction() {
    if (!pendingAction) return;
    try {
      await runCommand("reject_chat_action", { id: pendingAction.id });
      setPendingAction(undefined);
      setSelectedChoiceIndexes([]);
      setMessage("已取消该操作。");
    } catch (error) {
      setSaveError(String(error));
    }
  }

  async function toggleSpeech() {
    setSpeechError("");
    if (isSpeaking) {
      if (isTauriRuntime) {
        await runCommand("stop_local_speech");
      } else {
        window.speechSynthesis?.cancel();
      }
      setIsSpeaking(false);
      return;
    }
    if (isTauriRuntime) {
      try {
        await runCommand("speak_local_text", { text: message });
        setIsSpeaking(true);
      } catch (error) {
        setSpeechError(String(error));
      }
      return;
    }
    if (!("speechSynthesis" in window)) {
      setSpeechError("当前环境不支持朗读。");
      return;
    }
    const spokenMessage = textForSpeech(message).trim();
    if (!spokenMessage) {
      setSpeechError("没有可朗读的文字内容。");
      return;
    }
    const utterance = new SpeechSynthesisUtterance(spokenMessage);
    utterance.lang = "zh-CN";
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    setIsSpeaking(true);
  }

  async function clearAttachment() {
    await runCommand("clear_text_attachment");
    setAttachment(undefined);
    setAttachmentError("");
  }

  async function chooseAttachment() {
    if (!isTauriRuntime) return;
    const path = await open({
      multiple: false,
      filters: [{ name: "文本文件", extensions: ["txt", "md", "json", "csv", "log"] }],
    });
    if (!path) return;
    setAttachmentError("");
    try {
      setAttachment(await runCommand<AttachmentPreview>("prepare_text_attachment", { path }));
    } catch (error) {
      setAttachmentError(String(error));
    }
  }

  async function clearScreenshot() {
    await runCommand("clear_screen_capture");
    setScreenshot(undefined);
  }

  async function clearContext() {
    try {
      await runCommand("clear_chat_context");
      setChatHistory([]);
      setCurrentPrompt("");
      setMessage("");
      setPendingAction(undefined);
      setShowReplySkeleton(false);
      setContextNotice("已清空上下文。");
      window.setTimeout(() => setContextNotice(""), 3000);
    } catch (error) {
      setContextNotice(String(error));
    }
  }

  async function updateHtmlPreviewEnabled(enabled: boolean) {
    const settings = await runCommand<AppSettings>(
      "update_html_preview_enabled",
      { enabled },
      { ...defaultAppSettings, htmlPreviewEnabled: enabled },
    );
    setHtmlPreviewEnabled(settings.htmlPreviewEnabled);
  }

  async function saveResult() {
    setSaveError("");
    if (!isTauriRuntime) {
      setSaveError("桌面版中可保存回复到本地文件。");
      return;
    }
    const path = await save({
      defaultPath: "piko-response.md",
      filters: [{ name: "文本文件", extensions: ["txt", "md", "json", "csv", "py", "js", "ts", "html", "css", "rs", "toml", "log"] }],
    });
    if (!path) return;
    try {
      await runCommand("save_generated_text", { path, content: message, overwrite: false });
    } catch (error) {
      if (String(error).includes("目标文件已存在") && window.confirm("目标文件已存在，是否覆盖？")) {
        await runCommand("save_generated_text", { path, content: message, overwrite: true });
        return;
      }
      setSaveError(String(error));
    }
  }

  function toggleHistoryItem(id: string) {
    setExpandedHistoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function collapseAllHistory() {
    setExpandedHistoryIds(new Set());
  }

  const htmlPreviewSource = htmlPreviewEnabled ? extractHtmlPreviewSource(message) : null;

  return (
    <main className={`bubble-shell bubble-shell--${theme}`}>
      {/* Layer 1: Top Bar */}
      <header className="bubble-topbar" onPointerDown={startBubbleDrag}>
        <div className="bubble-topbar__left">
          <PetSprite mode={isThinking ? "thinking" : "idle"} compact />
          <span className="bubble-topbar__name">{companionName.toUpperCase()}</span>
        </div>
        <div className="bubble-topbar__center">
          <span className={`bubble-topbar__status${topbarStatus.pulse ? " bubble-topbar__status--pulse" : ""}`}>
            <span className="bubble-topbar__dot" />
            {topbarStatus.label}
          </span>
        </div>
        <div className="bubble-topbar__right">
          <button
            className="bubble-topbar__btn"
            type="button"
            onClick={() => runCommand("hide_bubble")}
            aria-label="关闭"
          >
            ×
          </button>
        </div>
      </header>

      {/* Layer 2: Thread Area */}
      <section className="bubble-thread" ref={threadScrollRef}>
        {showWelcome && <WelcomeState companionName={companionName} message={getBubbleCompanionMessage() || ""} />}

        {chatHistory.length > 0 && (
          <div className="bubble-thread__history">
            {chatHistory.map((entry) => (
              <HistoryItem
                key={entry.id}
                entry={entry}
                isExpanded={expandedHistoryIds.has(entry.id)}
                onToggle={() => toggleHistoryItem(entry.id)}
              />
            ))}
            {expandedHistoryIds.size > 0 && (
              <button type="button" className="bubble-thread__collapse-all" onClick={collapseAllHistory}>
                ── 折叠全部 ({expandedHistoryIds.size}) ──
              </button>
            )}
          </div>
        )}

        {hasCurrentTurn && (
          <div className="bubble-thread__current">
            {currentPrompt && (
              <div className="bubble-thread__user-bubble">
                {currentPrompt}
              </div>
            )}

            {showReplySkeleton ? (
              <div className="bubble-thread__ai-card bubble-thread__ai-card--loading">
                <div className="bubble-thread__ai-sprite">
                  <PetSprite mode="thinking" compact />
                </div>
                <div className="bubble-skeleton" role="status" aria-live="polite" aria-busy="true">
                  <div className="bubble-skeleton__eyebrow">
                    <span className="bubble-skeleton__dot" />
                    <span>{skeletonLabel}</span>
                    <span className="bubble-skeleton__typing" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                  </div>
                  <div className="bubble-skeleton__lines" aria-hidden="true">
                    {skeletonLines.map((className, index) => (
                      <span className={`bubble-skeleton__line ${className}`} key={index} />
                    ))}
                  </div>
                </div>
              </div>
            ) : pendingAction ? (
              <ActionConfirmationCard
                draft={pendingAction}
                selectedChoiceIndexes={selectedChoiceIndexes}
                onChoiceToggle={(choiceIndex) =>
                  setSelectedChoiceIndexes((current) =>
                    current.includes(choiceIndex) ? current.filter((value) => value !== choiceIndex) : [...current, choiceIndex],
                  )
                }
                onConfirm={() => void confirmAction()}
                onReject={() => void rejectAction()}
              />
            ) : htmlPreviewSource ? (
              <div className="bubble-thread__ai-card">
                <div className="bubble-thread__ai-sprite">
                  <PetSprite mode="idle" compact />
                </div>
                <HtmlPreviewFrame source={htmlPreviewSource} />
              </div>
            ) : message.trim() ? (
              <div className={`bubble-thread__ai-card${isReplyEntering ? " bubble-thread__ai-card--entering" : ""}`}>
                <div className="bubble-thread__ai-sprite">
                  <PetSprite mode="idle" compact />
                </div>
                <div className="bubble-thread__ai-content">
                  <MarkdownContent>{message}</MarkdownContent>
                </div>
              </div>
            ) : null}

            {!isThinking && message.trim() && !pendingAction && (
              <InlineToolbar
                message={message}
                isSpeaking={isSpeaking}
                copyFeedback={copyFeedback}
                htmlPreviewEnabled={htmlPreviewEnabled}
                onCopy={copyResult}
                onSpeech={toggleSpeech}
                onSave={() => void saveResult()}
                onUpdateHtmlPreview={(enabled) => void updateHtmlPreviewEnabled(enabled)}
                onClearContext={() => void clearContext()}
                onOpenPanel={() => runCommand("open_panel")}
              />
            )}
          </div>
        )}
      </section>

      {/* Layer 3: Input Zone */}
      <div className="bubble-input-zone">
        {hasInputContext && (
          <div className="bubble-input-zone__chips">
            {attachment && (
              <div className="bubble-input-zone__chip">
                <span className="bubble-input-zone__chip-text">
                  📄 {attachment.displayName} · {formatBytes(attachment.byteSize)}
                </span>
                <button type="button" className="bubble-input-zone__chip-remove" onClick={() => void clearAttachment()}>
                  ✕
                </button>
              </div>
            )}
            {screenshot && (
              <div className="bubble-input-zone__chip">
                <img src={screenshot.dataUrl} alt="" className="bubble-input-zone__chip-thumb" />
                <span className="bubble-input-zone__chip-text">截图 {screenshot.width}×{screenshot.height}</span>
                <button type="button" className="bubble-input-zone__chip-remove" onClick={() => void clearScreenshot()}>
                  ✕
                </button>
              </div>
            )}
            {attachmentError && <span className="bubble-input-zone__error">{attachmentError}</span>}
            {attachment && (
              <div className="bubble-input-zone__actions">
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
            )}
          </div>
        )}
        <form className="prompt-form" onSubmit={submit}>
          <div className="prompt-tools" aria-label="输入工具">
            <button type="button" onClick={() => void chooseAttachment()} aria-label="选择文件" title="选择文件">
              +
            </button>
            <button type="button" onClick={() => runCommand("begin_screen_capture")} aria-label="截图提问" title="截图提问">
              □
            </button>
          </div>
          <input
            autoFocus
            value={prompt}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            placeholder={attachment || screenshot ? "可补充处理要求" : "输入问题，或描述一个任务"}
            aria-label="发送给 Piko 的问题"
          />
          {isThinking ? (
            <button type="button" className="prompt-form__stop" onClick={cancel} title="停止生成">
              ■
            </button>
          ) : (
            <button type="submit" disabled={!prompt.trim() && !attachment && !screenshot}>
              ➤
            </button>
          )}
        </form>
      </div>

      {contextNotice && <p className="bubble-context-note" role="status">{contextNotice}</p>}
      {speechError && <p className="speech-error" role="alert">{speechError}</p>}
      {saveError && <p className="speech-error" role="alert">{saveError}</p>}
    </main>
  );
}
