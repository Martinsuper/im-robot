import { FormEvent, isValidElement, type PointerEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { ActionConfirmationCard, getConfirmationChoices } from "./ActionConfirmationCard";
import type { ActionDraft, ActionExecution, ChatEvent } from "./chatTypes";
import type { AttachmentAction, AttachmentPreview, AppSettings, ScreenshotPreview, Theme } from "../../types/appTypes";
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
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{1F1E6}-\u{1F1FF}\u200D\uFE0E\uFE0F\u20E3]/gu, "");
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

export function BubbleWindow() {
  const [prompt, setPrompt] = useState("");
  const [message, setMessage] = useState("你好，我是 Piko。今天想一起完成什么？");
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
  const [isReplyEntering, setIsReplyEntering] = useState(false);
  const activeRequestId = useRef<string | undefined>(undefined);
  const lastSequence = useRef(0);
  const previewReplyTimer = useRef<number | undefined>(undefined);
  const skeletonHideTimer = useRef<number | undefined>(undefined);
  const receivedFirstDelta = useRef(false);
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

  useEffect(() => {
    void runCommand<AppSettings>("get_settings", undefined, defaultAppSettings).then((settings) => {
      setCompanionName(settings.companionName);
      setTheme(settings.theme);
      setHtmlPreviewEnabled(settings.htmlPreviewEnabled);
      setMessage(`你好，我是 ${settings.companionName}。今天想一起完成什么？`);
    });
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
      void unlisten.then((dispose) => dispose());
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
      void unlisten.then((dispose) => dispose());
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
      }
      if (event.payload.type === "action-proposed") {
        setIsThinking(false);
        clearSkeletonHideTimer();
        setShowReplySkeleton(false);
        setIsReplyEntering(false);
        setMessage("请确认是否执行以下操作。");
        setPendingAction(event.payload.draft);
        setSelectedChoiceIndexes(getConfirmationChoices(event.payload.draft).map((choice) => choice.index));
      }
      if (event.payload.type === "cancelled") {
        setIsThinking(false);
        clearSkeletonHideTimer();
        setShowReplySkeleton(false);
        setIsReplyEntering(false);
        setMessage((current) => current || "已停止生成。");
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

  async function sendPrompt(currentPrompt: string) {
    if (!currentPrompt.trim() && !attachment && !screenshot) return;

    const requestPrompt = currentPrompt.trim();
    const currentRequestId = crypto.randomUUID();
    setIsThinking(true);
    setPendingAction(undefined);
    setSelectedChoiceIndexes([]);
    setMessage("Piko 正在连接模型服务...");
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

    const currentPrompt = prompt.trim();
    void sendPrompt(currentPrompt);
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
      setContextNotice("已清空上下文，下一次对话会从新会话开始。");
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

  const htmlPreviewSource = htmlPreviewEnabled ? extractHtmlPreviewSource(message) : null;

  return (
    <main className={`bubble-shell bubble-shell--${theme}`}>
      <header className="bubble-header" onPointerDown={startBubbleDrag}>
        <div className="companion-heading">
          <PetSprite mode={isThinking ? "thinking" : "idle"} compact />
          <div>
            <p className="eyebrow">{companionName.toUpperCase()} · QUICK CHAT</p>
            <h1>{isThinking ? "正在思考..." : "今天想做点什么？"}</h1>
          </div>
        </div>
        <div className="bubble-header__actions">
          <button
            type="button"
            className={htmlPreviewEnabled ? "is-active" : ""}
            title="HTML 预览插件"
            aria-label="HTML 预览插件"
            onClick={() => void updateHtmlPreviewEnabled(!htmlPreviewEnabled)}
          >
            HTML
          </button>
          <button className="close-button" type="button" onClick={() => runCommand("hide_bubble")} aria-label="关闭">
            ×
          </button>
        </div>
      </header>
      <div className={`bubble-reply-stage${showReplySkeleton ? " bubble-reply-stage--loading" : ""}`}>
        {showReplySkeleton ? (
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
        ) : null}
        <div className={`bubble-message${isReplyEntering ? " bubble-message--entering" : ""}`}>
          {htmlPreviewSource ? (
            <HtmlPreviewFrame source={htmlPreviewSource} />
          ) : message.trim() ? (
            <MarkdownContent>{message}</MarkdownContent>
          ) : null}
        </div>
      </div>
      {pendingAction && (
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
      )}
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
          <div className="attachment-empty">
            <p>{isDraggingFile ? "松开即可读取文本文件" : "拖入 .txt、.md、.json、.csv 或 .log 文件"}</p>
            <button type="button" onClick={() => void chooseAttachment()}>选择文件</button>
          </div>
        )}
        {attachmentError && <span className="attachment-error">{attachmentError}</span>}
      </section>
      <section className="screenshot-card">
        {screenshot ? (
          <>
            <img src={screenshot.dataUrl} alt="待发送的截图预览" />
            <div>
              <strong>截图已确认</strong>
              <span>{screenshot.width} × {screenshot.height}</span>
              <button type="button" onClick={() => void clearScreenshot()}>移除截图</button>
            </div>
          </>
        ) : (
          <button type="button" onClick={() => runCommand("begin_screen_capture")}>
            截图提问
          </button>
        )}
      </section>
      <form className="prompt-form" onSubmit={submit}>
        <input
          autoFocus
          value={prompt}
          onChange={(event) => setPrompt(event.currentTarget.value)}
          placeholder={attachment || screenshot ? "可补充处理要求" : "输入问题，或描述一个任务"}
          aria-label="发送给 Piko 的问题"
        />
        <button type="submit" disabled={(!prompt.trim() && !attachment && !screenshot) || isThinking}>
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
          <button type="button" disabled={!message} onClick={() => void toggleSpeech()}>
            {isSpeaking ? "停止朗读" : "朗读回复"}
          </button>
          <button type="button" disabled={!message} onClick={() => void saveResult()}>
            保存回复
          </button>
          <button type="button" onClick={() => void clearContext()}>
            清空上下文
          </button>
          <button type="button" onClick={() => runCommand("open_panel")}>
            打开面板
          </button>
        </div>
      </footer>
      {contextNotice && <p className="bubble-context-note" role="status">{contextNotice}</p>}
      {speechError && <p className="speech-error" role="alert">{speechError}</p>}
      {saveError && <p className="speech-error" role="alert">{saveError}</p>}
    </main>
  );
}
