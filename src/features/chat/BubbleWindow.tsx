import { useStableEvent } from "../../hooks/useStableEvent";
import { HtmlFavoriteDialog } from "./HtmlFavoriteDialog";
import { AgentActivity } from "./AgentActivity";
import { TaskHistory } from "./TaskHistory";
import { TaskDiagnostics } from "./TaskDiagnostics";
import { TaskOutcome } from "./TaskOutcome";
import type { TaskTerminal } from "./taskOutcomeModel";
import { CONVERSATION_STORAGE, loadConversation, type AgentEvent, type ToolActivity, type ToolApproval } from "./agentTypes";
import {
  CollapsibleReply,
  HistoryItem,
  InlineToolbar,
  ModelSetupCard,
  ReplyStatusCard,
  WelcomeState,
  openModelSettings,
  textForSpeech,
} from "./ChatPresentation";
import { ArrowUp, Mic, Paperclip, ScanLine, Square, Star, X } from "lucide-react";
import { FormEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { ActionConfirmationCard, getConfirmationChoices } from "./ActionConfirmationCard";
import { getBubbleCompanionMessage } from "./bubbleMessage";
import type { ActionDraft, ActionExecution, ChatEvent } from "./chatTypes";
import type { AttachmentAction, AttachmentPreview, AppSettings, ChatHistoryEntry, ScreenshotPreview, Theme } from "../../types/appTypes";
import { PetSprite, attachmentActionOptions, defaultAppSettings, formatBytes } from "../app/appShared";
import { isTauriRuntime, runCommand } from "../app/appRuntime";
import { useToast } from "../../components/feedback/toastStore";
import { toUserMessage } from "../../lib/errors";
import { extractHtmlPreviewSource, HtmlPreviewFrame, type HtmlPreviewView } from "./HtmlPreviewFrame";
import { findFavoriteId, useHtmlFavorites } from "./htmlFavorites";

type VoiceTranscriptionOutput = {
  text: string;
};

const WHISPER_SAMPLE_RATE = 16000;

// --- Main Component ---

export function BubbleWindow() {
  const toast = useToast();
  const [prompt, setPrompt] = useState("");
  const [conversation, setConversation] = useState(loadConversation);
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const [agentBusy, setAgentBusy] = useState(false);
  const [verificationOf, setVerificationOf] = useState<string>();
  const [resumeOf, setResumeOf] = useState<string>();
  const [sendingSteering, setSendingSteering] = useState(false);
  const steeringPending = useRef(false);
  const agentBusyRef = useRef(false);
  const displayedRequestId = useRef<string | undefined>(undefined);
  const [agentStatus, setAgentStatus] = useState("");
  const [agentTools, setAgentTools] = useState<ToolActivity[]>([]);
  const [taskTerminal, setTaskTerminal] = useState<TaskTerminal | null>(null);
  const [agentApprovals, setAgentApprovals] = useState<ToolApproval[]>([]);
  const [workspaceRequired, setWorkspaceRequired] = useState(false);
  const businessAction = useRef(false);
  const businessCardRef = useRef<HTMLDivElement>(null);
  const agentReady = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => { try { localStorage.setItem(CONVERSATION_STORAGE, JSON.stringify(conversation)); } catch { /* Optional. */ } }, [conversation]);

  const [message, setMessage] = useState("");
  const [companionName, setCompanionName] = useState("Piko");
  const [theme, setTheme] = useState<Theme>("sage");
  const [htmlPreviewEnabled, setHtmlPreviewEnabled] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  /**
   * 回复状态机（02 §4）：thinking / streaming 时是 null，结束后落到 done / failed / cancelled。
   * 失败与停止都**不再把错误塞进 message**——那会让错误以 Markdown 正文的样子出现。
   */
  const [replyStatus, setReplyStatus] = useState<"done" | "failed" | "cancelled" | null>(null);
  const [replyError, setReplyError] = useState("");
  /** thinking 超过 8s 给一句安抚（02 §4）。 */
  const [isThinkingLong, setIsThinkingLong] = useState(false);
  const [attachment, setAttachment] = useState<AttachmentPreview>();
  const [attachmentAction, setAttachmentAction] = useState<AttachmentAction>("summarize");
  const [screenshot, setScreenshot] = useState<ScreenshotPreview>();
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isTranscribingVoice, setIsTranscribingVoice] = useState(false);
  const [contextNotice, setContextNotice] = useState("");
  const [requestId, setRequestId] = useState<string>();
  const [pendingAction, setPendingAction] = useState<ActionDraft>();
  const [selectedChoiceIndexes, setSelectedChoiceIndexes] = useState<number[]>([]);
  const [pendingPromptSummary, setPendingPromptSummary] = useState({ length: 0, hasAttachment: false, hasScreenshot: false });
  const [showReplySkeleton, setShowReplySkeleton] = useState(false);
  const [memoryActivity, setMemoryActivity] = useState<string>("");
  const [isReplyEntering, setIsReplyEntering] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(true);
  // New state for redesign
  const [chatHistory, setChatHistory] = useState<ChatHistoryEntry[]>([]);
  const [expandedHistoryIds, setExpandedHistoryIds] = useState<Set<string>>(new Set());
  const [historySourceIds, setHistorySourceIds] = useState<Set<string>>(new Set());
  const [currentPrompt, setCurrentPrompt] = useState("");
  const [copyFeedback, setCopyFeedback] = useState(false);
  const { favorites, toggle: toggleFavorite, remove: removeFavorite } = useHtmlFavorites();
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [selectedFavoriteId, setSelectedFavoriteId] = useState<string | null>(null);
  const favoritesButtonRef = useRef<HTMLButtonElement>(null);
  const hasInputContext = Boolean(attachment || screenshot || isDraggingFile);
  const activeRequestId = useRef<string | undefined>(undefined);
  const lastSequence = useRef(0);
  const mountedRef = useRef(true);
  const previewReplyTimer = useRef<number | undefined>(undefined);
  const thinkingLongTimer = useRef<number | undefined>(undefined);
  const skeletonHideTimer = useRef<number | undefined>(undefined);
  const receivedFirstDelta = useRef(false);
  const threadScrollRef = useRef<HTMLDivElement>(null);
  const promptInputRef = useRef<HTMLInputElement>(null);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceAudioContextRef = useRef<AudioContext | null>(null);
  const voiceProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const voiceSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const voiceSamplesRef = useRef<Float32Array[]>([]);
  const voiceSampleRateRef = useRef(WHISPER_SAMPLE_RATE);
  const confirmationChoices = pendingAction ? getConfirmationChoices(pendingAction) : [];
  useEffect(() => {
    if (!pendingAction) return;
    const buttons = Array.from(businessCardRef.current?.querySelectorAll("button") || []);
    (buttons.find((button) => button.textContent?.includes("确认执行")) || buttons[0])?.scrollIntoView?.({ block: "center" });
  }, [pendingAction]);
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
    if (agentBusy) return { label: agentStatus || "正在处理…", pulse: true };
    if (isThinking) return { label: "思考中…", pulse: true };
    return { label: "在线", pulse: false };
  }, [isThinking, isSpeaking, memoryActivity, agentBusy, agentStatus]);

  const hasCurrentTurn = Boolean(currentPrompt || message || pendingAction || showReplySkeleton || agentTools.length || workspaceRequired);
  const showWelcome = !hasCurrentTurn && chatHistory.length === 0;

  // 02 §3.3：Esc 收起窗口；Cmd/Ctrl + Enter 发送
  function handleWindowKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (agentBusyRef.current) cancel(); else void runCommand("hide_bubble");
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submitPrompt();
    }
  }

  function startBubbleDrag(event: PointerEvent<HTMLElement>) {
    if (!isTauriRuntime || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, textarea, select, a, [data-no-drag]")) return;
    void getCurrentWindow().startDragging();
  }

  function clearSkeletonHideTimer() {
    if (thinkingLongTimer.current) {
      window.clearTimeout(thinkingLongTimer.current);
      thinkingLongTimer.current = undefined;
    }
    if (skeletonHideTimer.current) {
      window.clearTimeout(skeletonHideTimer.current);
      skeletonHideTimer.current = undefined;
    }
  }

  const hideSkeletonSoon = useStableEvent(() => {
    clearSkeletonHideTimer();
    skeletonHideTimer.current = window.setTimeout(() => {
      setShowReplySkeleton(false);
      setIsReplyEntering(false);
      skeletonHideTimer.current = undefined;
    }, 220);
  });

  function refreshChatHistory() {
    if (!isTauriRuntime) return;
    void runCommand<ChatHistoryEntry[]>("get_bubble_chat_history", undefined, []).then((entries) => {
      if (entries) { const current = conversationRef.current; setChatHistory((current.importHistory ? entries : entries.filter((entry) => current.turnIds.includes(entry.id))).filter((entry) => entry.id !== displayedRequestId.current)); }
    });
  }

  const stopVoiceRecording = useStableEvent((shouldTranscribe = true) => {
    const samples = voiceSamplesRef.current;
    const sampleRate = voiceSampleRateRef.current;
    voiceSamplesRef.current = [];
    stopVoiceStream();
    setIsListening(false);
    if (!shouldTranscribe) return;
    if (!samples.length) {
      toast.info("没有录到语音内容。");
      return;
    }
    const blob = encodeWav(samples, sampleRate);
    void transcribeVoiceBlob(blob);
  });

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
      // 02 §10.4：未配置模型也要能打开对话，但要给引导卡
      setAiConfigured(settings.hasApiKey || settings.ai.baseUrl.includes("localhost") || settings.ai.baseUrl.includes("127.0.0.1"));
    });
    refreshChatHistory();
  }, []);

  useEffect(() => {
    return () => {
      stopVoiceRecording(false);
      voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
      window.speechSynthesis?.cancel();
      if (isTauriRuntime) void runCommand("stop_local_speech");
      clearSkeletonHideTimer();
    };
  }, [stopVoiceRecording]);

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
    let focusTimer: number | undefined;
    const unlistenFocus = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      window.clearTimeout(focusTimer);
      if (!focused) return;
      refreshScreenshot();
      // Cancel delayed composer focus when a detached preview takes focus.
      focusTimer = window.setTimeout(() => {
        promptInputRef.current?.focus();
      }, 80);
    });
    return () => {
      window.clearTimeout(focusTimer);
      void unlisten.then((dispose) => dispose());
      void unlistenFocus.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime) return;

    const onChatEvent = (event: { payload: ChatEvent }) => {
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
        setAgentBusy(false); agentBusyRef.current = false;
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
        setAgentBusy(false); agentBusyRef.current = false;
        setIsThinking(false);
        clearSkeletonHideTimer();
        setShowReplySkeleton(false);
        setIsReplyEntering(false);
        setReplyStatus("cancelled");
        refreshChatHistory();
      }
      if (event.payload.type === "failed") {
        setAgentBusy(false); agentBusyRef.current = false;
        setIsThinking(false);
        clearSkeletonHideTimer();
        setShowReplySkeleton(false);
        setIsReplyEntering(false);
        setReplyStatus("failed");
        setReplyError(event.payload.message);
      }
    };
    const unlisten = listen<ChatEvent>("chat-event", onChatEvent);
    const agentUnlisten = listen<AgentEvent>("agent-event", ({ payload: event }) => {
      if (event.requestId !== activeRequestId.current) return;
      if (event.type === "started") { onChatEvent({ payload: { type: "started", requestId: event.requestId, working: false } }); return; }
      if (event.type === "delta") {
        onChatEvent({ payload: { type: "delta", requestId: event.requestId, sequence: lastSequence.current + 1, text: event.text || "" } }); return;
      }
      if (event.type === "tool-start") {
        setShowReplySkeleton(false); clearSkeletonHideTimer(); setIsThinking(false);
        setAgentStatus(`正在调用 ${event.tool}…`);
        setAgentTools((tools) => [...tools, { id: event.toolCallId || "", name: event.tool || "工具", arguments: event.arguments || {}, status: "执行中" }]);
      }
      if (event.type === "tool-end") {
        setAgentTools((tools) => tools.map((tool) => tool.id === event.toolCallId ? { ...tool, status: event.isError ? "失败" : "完成", output: event.output, verification: event.verification } : tool));
        setAgentStatus("正在继续…");
      }
      if (event.type === "approval" && event.approvalId) {
        setShowReplySkeleton(false); clearSkeletonHideTimer(); setIsThinking(false);
        setAgentApprovals((items) => [...items, { id: event.approvalId!, tool: event.tool || "操作", arguments: event.arguments || {} }]);
        setAgentStatus("等待你批准操作");
      }
      if (event.type === "steering-accepted") {
        steeringPending.current = false; setSendingSteering(false);
        setPrompt((current) => current.trim() === event.text?.trim() ? "" : current);
        setAgentApprovals([]); setPendingAction(undefined); businessAction.current = false; setWorkspaceRequired(false);
        setAgentStatus("补充要求已加入；正在执行的操作可能已产生效果");
        setCurrentPrompt((current) => `${current}\n补充要求：${event.text || ""}`);
      }
      if (event.type === "approval-expired") {
        setAgentApprovals((items) => items.filter((item) => item.id !== event.approvalId));
        setAgentStatus("操作确认已超时，该操作未获批准");
      }
      if (event.type === "workspace-required") {
        setWorkspaceRequired(true); setShowReplySkeleton(false); clearSkeletonHideTimer(); setIsThinking(false); setAgentStatus("请选择工作目录");
      }
      if (event.type === "action-proposed" && event.draft) {
        businessAction.current = true;
        onChatEvent({ payload: { type: "action-proposed", requestId: event.requestId, draft: event.draft } });
        setAgentStatus("等待你确认操作");
      }
      if (event.type === "protocol-error") setReplyError(event.message || "通信失败");
      if (event.type === "completed" || event.type === "cancelled" || event.type === "failed") {
        setAgentBusy(false); agentBusyRef.current = false; setAgentStatus(""); setWorkspaceRequired(false); setAgentApprovals([]);
        setPendingAction(undefined); businessAction.current = false;
        steeringPending.current = false; setSendingSteering(false);
        setTaskTerminal({ requestId: event.requestId, status: event.type });
        setAgentTools((tools) => tools.map((tool) => tool.status === "执行中" ? { ...tool, status: "结果未知" } : tool));
        if (event.type === "completed") setReplyStatus("done");
        onChatEvent({ payload: event.type === "failed" ? { type: "failed", requestId: event.requestId, message: event.message || "处理失败" } : { type: event.type, requestId: event.requestId } });
        activeRequestId.current = undefined; setRequestId(undefined);
      }
    });
    agentReady.current = agentUnlisten;

    return () => {
      void agentUnlisten.then((dispose) => dispose());
      if (activeRequestId.current && agentBusyRef.current) void runCommand("agent_cancel", { requestId: activeRequestId.current }).catch(() => {});
      void unlisten.then((dispose) => {
        if (mountedRef.current) dispose();
      });
    };
  }, [hideSkeletonSoon]);

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
        toast.error("一次只能处理一个文本文件。");
        return;
      }

      void runCommand<AttachmentPreview>("prepare_text_attachment", {
        path: event.payload.paths[0],
      })
        .then(setAttachment)
        .catch((error) => toast.error(toUserMessage(error, "附件读取失败，请重试。")));
    });

    return () => {
      void unlisten.then((dispose) => {
        if (mountedRef.current) dispose();
      });
    };
  }, [toast]);

  // Auto-scroll thread to bottom when new messages arrive
  useEffect(() => {
    if (agentApprovals.length || workspaceRequired || pendingAction) return;
    const el = threadScrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [message, showReplySkeleton, currentPrompt, chatHistory.length, agentApprovals.length, workspaceRequired, pendingAction]);

  async function sendPrompt(currentPromptValue: string, inspectionTarget: string | null = verificationOf ?? null, resumeTarget: string | null = resumeOf ?? null) {
    if (agentBusyRef.current || (!currentPromptValue.trim() && !attachment && !screenshot)) return;

    const requestPrompt = currentPromptValue.trim();
    if (displayedRequestId.current && (currentPrompt || message)) {
      const previous = { id: displayedRequestId.current, prompt: currentPrompt, response: message, createdAt: Math.floor(Date.now() / 1000) };
      setChatHistory((entries) => [...entries.filter((entry) => entry.id !== previous.id), previous]);
    }
    const currentRequestId = crypto.randomUUID();
    displayedRequestId.current = currentRequestId;
    const currentConversation = conversationRef.current;
    const nextConversation = { ...currentConversation, id: currentConversation.id || currentRequestId, turnIds: [...currentConversation.turnIds, currentRequestId] };
    conversationRef.current = nextConversation;
    setConversation(nextConversation);
    setTaskTerminal(null);
    setAgentTools([]); setAgentApprovals([]); setWorkspaceRequired(false); setAgentStatus("");
    businessAction.current = false;

    setCurrentPrompt(requestPrompt);
    setIsThinking(true);
    setPendingAction(undefined);
    setSelectedChoiceIndexes([]);
    setMessage("");
    setReplyStatus(null);
    setReplyError("");
    setIsThinkingLong(false);
    setShowReplySkeleton(true);
    if (thinkingLongTimer.current) window.clearTimeout(thinkingLongTimer.current);
    thinkingLongTimer.current = window.setTimeout(() => {
      // thinking 超过 8s 给一句安抚（02 §4）
      setIsThinkingLong(true);
    }, 8000);
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
        setReplyStatus("done");
        setIsThinking(false);
        clearSkeletonHideTimer();
        setShowReplySkeleton(false);
        setIsReplyEntering(false);
      }, 450);
      return;
    }

    setAgentBusy(true); agentBusyRef.current = true;
    void agentReady.current.then(() => runCommand<void>("agent_start", {
      input: {
        requestId: currentRequestId,
        conversationId: nextConversation.id, cwd: nextConversation.cwd || undefined, unified: true, importHistory: nextConversation.importHistory,
        prompt: requestPrompt,
        attachmentAction: attachment ? attachmentAction : undefined,
        includeScreenshot: Boolean(screenshot),
        verificationOf: inspectionTarget,
        resumeOf: resumeTarget,
      },
    })).catch((error) => {
      setAgentBusy(false); agentBusyRef.current = false;
      setPrompt(requestPrompt);
      setIsThinking(false);
      setShowReplySkeleton(false);
      setReplyStatus("failed");
      setReplyError(toUserMessage(error, "网络好像不太稳定"));
    });
  }

  function submitPrompt() {
    if (agentBusyRef.current) {
      const text = prompt.trim();
      if (!text || steeringPending.current) return;
      steeringPending.current = true; setSendingSteering(true);
      void runCommand("agent_steer", { requestId: activeRequestId.current, text }).catch((error) => { steeringPending.current = false; setSendingSteering(false); toast.error(toUserMessage(error, "补充要求未送达，请重试")); });
      return;
    }
    if (!prompt.trim() && !attachment && !screenshot) return;
    void sendPrompt(prompt.trim());
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submitPrompt();
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
      setReplyStatus("cancelled");
      return;
    }
    void runCommand("agent_cancel", { requestId }).catch((error) => toast.error(toUserMessage(error, "停止失败")));
  }

  async function chooseWorkspace() {
    try {
      const path = await open({ directory: true, multiple: false, title: "选择工作目录" });
      if (typeof path !== "string") return;
      setConversation((current) => ({ ...current, cwd: path }));
      if (workspaceRequired) {
        await runCommand("agent_select_workspace", { requestId: activeRequestId.current, path });
        setWorkspaceRequired(false); setAgentStatus("目录已选择，正在继续…");
      }
    } catch (error) { toast.error(toUserMessage(error, "选择目录失败")); }
  }
  async function cancelWorkspace() {
    try { await runCommand("agent_select_workspace", { requestId: activeRequestId.current, path: null }); setWorkspaceRequired(false); }
    catch (error) { toast.error(toUserMessage(error, "取消失败")); }
  }
  async function approveTool(id: string, allowed: boolean) {
    try {
      await runCommand("agent_approve", { requestId: activeRequestId.current, approvalId: id, allowed });
      setAgentApprovals((items) => items.filter((item) => item.id !== id));
      setAgentStatus(allowed ? "已批准，正在继续…" : "已拒绝，正在继续…");
    } catch (error) { toast.error(toUserMessage(error, "确认失败")); }
  }
  function inspectTask(requestId: string) {
    if (agentBusyRef.current) return;
    setResumeOf(undefined); setVerificationOf(requestId);
    void sendPrompt(`请只读核对任务 ${requestId} 的实际执行结果。先确认目标和验收标准，按证据说明哪些已完成、哪些未完成、哪些无法确认，不要重新执行修改。`, requestId, null);
  }

  function resumeTask(record: { requestId: string; conversationId: string }) {
    if (agentBusyRef.current) return;
    setVerificationOf(undefined); setResumeOf(record.requestId);
    const next = { ...conversationRef.current, id: record.conversationId, importHistory: false, turnIds: [] };
    conversationRef.current = next; setConversation(next); setChatHistory([]);
    void sendPrompt(`请根据原会话和操作检查点先核对任务 ${record.requestId} 的实际结果，再安全继续未完成的步骤。已完成步骤不能重复执行；无法证明幂等的操作请先说明并等待新的明确指令。`, null, record.requestId);
  }

  function newConversation() {
    setVerificationOf(undefined); setResumeOf(undefined);
    displayedRequestId.current = undefined;
    const next = { id: "", cwd: conversation.cwd, importHistory: false, turnIds: [] };
    conversationRef.current = next; setConversation(next); setChatHistory([]); setCurrentPrompt(""); setMessage("");
    setTaskTerminal(null);
    setAgentTools([]); setAgentApprovals([]); setReplyStatus(null); setReplyError(""); setPendingAction(undefined);
  }

  async function copyResult() {
    await navigator.clipboard.writeText(message);
    setCopyFeedback(true);
    window.setTimeout(() => setCopyFeedback(false), 1200);
  }

  async function confirmAction() {
    if (!pendingAction) return;
    try {
      if (pendingAction.pluginId === "piko.reminders" && isTauriRuntime && !(await isPermissionGranted())) {
        await requestPermission();
      }
      if (businessAction.current) {
        await runCommand("agent_confirm_action", { requestId: activeRequestId.current, id: pendingAction.id, selectedIndexes: confirmationChoices.length ? selectedChoiceIndexes : undefined });
        setPendingAction(undefined); setSelectedChoiceIndexes([]); businessAction.current = false; setAgentStatus("已确认，正在继续…"); return;
      }
      const execution = await runCommand<ActionExecution>("confirm_chat_action", {
        id: pendingAction.id,
        selectedIndexes: confirmationChoices.length ? selectedChoiceIndexes : undefined,
      });
      setPendingAction(undefined);
      setSelectedChoiceIndexes([]);
      setMessage(execution.message);
      // Execution already returned the authoritative result. A second model
      // request can misclassify that result or propose the same action again.
      activeRequestId.current = undefined;
      setRequestId(undefined);
      setReplyStatus("done");
      setReplyError("");
      setIsThinking(false);
      clearSkeletonHideTimer();
      setShowReplySkeleton(false);
      setIsReplyEntering(false);
      refreshChatHistory();
    } catch (error) {
      toast.error(toUserMessage(error, "保存失败，请重试。"));
    }
  }

  async function rejectAction() {
    if (!pendingAction) return;
    try {
      if (businessAction.current) {
        await runCommand("agent_reject_action", { requestId: activeRequestId.current, id: pendingAction.id });
        setPendingAction(undefined); setSelectedChoiceIndexes([]); businessAction.current = false; setAgentStatus("已拒绝，正在继续…"); return;
      }
      await runCommand("reject_chat_action", { id: pendingAction.id });
      setPendingAction(undefined);
      setSelectedChoiceIndexes([]);
      setMessage("已取消该操作。");
    } catch (error) {
      toast.error(toUserMessage(error, "保存失败，请重试。"));
    }
  }

  async function toggleSpeech() {
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
        toast.error(toUserMessage(error, "朗读失败，请重试。"));
      }
      return;
    }
    if (!("speechSynthesis" in window)) {
      toast.info("当前环境不支持朗读。");
      return;
    }
    const spokenMessage = textForSpeech(message).trim();
    if (!spokenMessage) {
      toast.info("没有可朗读的文字内容。");
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

  function appendSpeechText(base: string, text: string) {
    const normalizedText = text.trim();
    if (!normalizedText) return base;
    if (!base.trim()) return normalizedText;
    return `${base.trimEnd()} ${normalizedText}`;
  }

  function encodeWav(samples: Float32Array[], sampleRate: number) {
    const sampleCount = samples.reduce((sum, chunk) => sum + chunk.length, 0);
    const buffer = new ArrayBuffer(44 + sampleCount * 2);
    const view = new DataView(buffer);
    let offset = 0;
    const writeString = (value: string) => {
      for (let index = 0; index < value.length; index += 1) {
        view.setUint8(offset, value.charCodeAt(index));
        offset += 1;
      }
    };
    writeString("RIFF");
    view.setUint32(offset, 36 + sampleCount * 2, true); offset += 4;
    writeString("WAVE");
    writeString("fmt ");
    view.setUint32(offset, 16, true); offset += 4;
    view.setUint16(offset, 1, true); offset += 2;
    view.setUint16(offset, 1, true); offset += 2;
    view.setUint32(offset, sampleRate, true); offset += 4;
    view.setUint32(offset, sampleRate * 2, true); offset += 4;
    view.setUint16(offset, 2, true); offset += 2;
    view.setUint16(offset, 16, true); offset += 2;
    writeString("data");
    view.setUint32(offset, sampleCount * 2, true); offset += 4;
    for (const chunk of samples) {
      for (const sample of chunk) {
        const clamped = Math.max(-1, Math.min(1, sample));
        view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
        offset += 2;
      }
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("无法读取录音数据。"));
      reader.readAsDataURL(blob);
    });
  }

  function stopVoiceStream() {
    voiceProcessorRef.current?.disconnect();
    voiceSourceRef.current?.disconnect();
    void voiceAudioContextRef.current?.close();
    voiceProcessorRef.current = null;
    voiceSourceRef.current = null;
    voiceAudioContextRef.current = null;
    voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
    voiceStreamRef.current = null;
  }



  async function transcribeVoiceBlob(blob: Blob) {
    if (blob.size <= 44) {
      toast.info("没有录到语音内容。");
      return;
    }
    setIsTranscribingVoice(true);
    try {
      const audioDataUrl = await blobToDataUrl(blob);
      const result = await runCommand<VoiceTranscriptionOutput>("transcribe_voice_input", {
        input: { audioDataUrl },
      });
      setPrompt((current) => appendSpeechText(current, result.text));
      promptInputRef.current?.focus();
    } catch (error) {
      toast.error(`语音转文字失败：${toUserMessage(error)}`);
    } finally {
      setIsTranscribingVoice(false);
    }
  }

  async function toggleVoiceInput() {
    if (isListening) {
      stopVoiceRecording();
      return;
    }
    if (!isTauriRuntime) {
      toast.info("浏览器预览无法调用本地语音模型，请在桌面应用中使用。");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
      toast.info("当前环境不支持麦克风录音。");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      voiceSamplesRef.current = [];
      voiceSampleRateRef.current = audioContext.sampleRate;
      processor.onaudioprocess = (event) => {
        voiceSamplesRef.current.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(audioContext.destination);
      voiceStreamRef.current = stream;
      voiceAudioContextRef.current = audioContext;
      voiceSourceRef.current = source;
      voiceProcessorRef.current = processor;
      setIsListening(true);
      promptInputRef.current?.focus();
    } catch (error) {
      setIsListening(false);
      stopVoiceStream();
      toast.error(`无法启动录音：${toUserMessage(error)}`);
    }
  }

  async function clearAttachment() {
    await runCommand("clear_text_attachment");
    setAttachment(undefined);
  }

  async function chooseAttachment() {
    if (!isTauriRuntime) return;
    const path = await open({
      multiple: false,
      filters: [{ name: "文本文件", extensions: ["txt", "md", "json", "csv", "log"] }],
    });
    if (!path) return;
    try {
      setAttachment(await runCommand<AttachmentPreview>("prepare_text_attachment", { path }));
    } catch (error) {
      toast.error(toUserMessage(error, "附件读取失败，请重试。"));
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
      setContextNotice(toUserMessage(error, "清空上下文失败，请重试。"));
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
    if (!isTauriRuntime) {
      toast.info("桌面版中可保存回复到本地文件。");
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
      toast.error(toUserMessage(error, "保存失败，请重试。"));
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

  function setHistoryPreview(id: string, view: HtmlPreviewView) {
    setHistorySourceIds((prev) => {
      const next = new Set(prev);
      if (view === "source") next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function collapseAllHistory() {
    setExpandedHistoryIds(new Set());
  }

  const htmlPreviewSource = htmlPreviewEnabled ? extractHtmlPreviewSource(message) : null;
  const currentFavoriteId = htmlPreviewSource ? findFavoriteId(favorites, htmlPreviewSource) : undefined;
  const selectedFavorite = selectedFavoriteId ? favorites.find((item) => item.id === selectedFavoriteId) : undefined;

  return (
    <main
      className={`bubble-shell bubble-shell--${theme}`}
      onKeyDown={handleWindowKeyDown}
      tabIndex={-1}
    >
      {/* Layer 1: Top Bar */}
      <header className="bubble-topbar" onPointerDown={startBubbleDrag}>
        <div className="bubble-topbar__left">
          <PetSprite mode={isThinking ? "thinking" : "idle"} compact />
          <span className="bubble-topbar__name">{companionName}</span>
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
            <X size={17} />
          </button>
        </div>
      </header>

      {/* Layer 2: Thread Area */}
      <section className="bubble-thread" ref={threadScrollRef} aria-label="对话内容">
        <TaskHistory busy={agentBusy} onInspect={(record) => inspectTask(record.requestId)} onResume={resumeTask} />
        {verificationOf && <section className="task-history" aria-label="只读核对模式">
          <strong>正在只读核对结果</strong>
          <p>后续提问继续核对，不执行命令或修改。需要继续处理时，请先结束核对，再明确提出操作要求。</p>
          <button type="button" disabled={agentBusy} onClick={() => setVerificationOf(undefined)}>结束核对</button>
        </section>}
        {resumeOf && <section className="task-history" aria-label="安全续跑模式"><strong>正在安全续跑</strong><p>文件修改按检查点和读回结果续接；Shell 和未经证明的业务写入不会自动重放。</p><button type="button" disabled={agentBusy} onClick={() => setResumeOf(undefined)}>结束续跑</button></section>}
        {showWelcome && !aiConfigured && (
          <ModelSetupCard onOpenSettings={openModelSettings} />
        )}
        {showWelcome && <WelcomeState companionName={companionName} message={getBubbleCompanionMessage() || ""} onSuggest={(suggestion) => { setPrompt(suggestion); promptInputRef.current?.focus(); }} />}

        {chatHistory.length > 0 && (
          <div className="bubble-thread__history">
            {chatHistory.map((entry) => {
              const entrySource = extractHtmlPreviewSource(entry.response);
              return (
                <HistoryItem
                  key={entry.id}
                  entry={entry}
                  isExpanded={expandedHistoryIds.has(entry.id)}
                  htmlPreviewEnabled={htmlPreviewEnabled}
                  previewAsSource={historySourceIds.has(entry.id)}
                  isFavorited={entrySource ? Boolean(findFavoriteId(favorites, entrySource)) : false}
                  onToggle={() => toggleHistoryItem(entry.id)}
                  onPreviewViewChange={(view) => setHistoryPreview(entry.id, view)}
                  onToggleFavorite={entrySource ? () => void toggleFavorite(entrySource, entry.id).catch((error) => toast.error(toUserMessage(error, "收藏失败，请重试。"))) : undefined}
                />
              );
            })}
            {expandedHistoryIds.size > 0 && (
              <button type="button" className="bubble-thread__collapse-all" onClick={collapseAllHistory}>
                收起历史记录 · {expandedHistoryIds.size}
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

            {isThinkingLong && isThinking ? (
          <p className="bubble-thread__thinking-long" role="status">还在思考，稍等一下…</p>
        ) : null}
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
              <div ref={businessCardRef}><ActionConfirmationCard
                draft={pendingAction}
                selectedChoiceIndexes={selectedChoiceIndexes}
                onChoiceToggle={(choiceIndex) =>
                  setSelectedChoiceIndexes((current) =>
                    current.includes(choiceIndex) ? current.filter((value) => value !== choiceIndex) : [...current, choiceIndex],
                  )
                }
                onConfirm={() => void confirmAction()}
                onReject={() => void rejectAction()}
              /></div>
            ) : htmlPreviewSource ? (
              <div className="bubble-thread__ai-card">
                <div className="bubble-thread__ai-sprite">
                  <PetSprite mode="idle" compact />
                </div>
                <HtmlPreviewFrame
                  source={htmlPreviewSource}
                  isFavorited={Boolean(currentFavoriteId)}
                  onToggleFavorite={() => void toggleFavorite(htmlPreviewSource).catch((error) => toast.error(toUserMessage(error, "收藏失败，请重试。")))}
                />
              </div>
            ) : message.trim() ? (
              <div className={`bubble-thread__ai-card${isReplyEntering ? " bubble-thread__ai-card--entering" : ""}`}>
                <div className="bubble-thread__ai-sprite">
                  <PetSprite mode="idle" compact />
                </div>
                <div className="bubble-thread__ai-content">
                  <CollapsibleReply markdown={message} />
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
            <TaskOutcome key={taskTerminal?.requestId || "pending"} terminal={taskTerminal} tools={agentTools} busy={agentBusy} onInspect={inspectTask} />
            <TaskDiagnostics key={`diagnostics-${taskTerminal?.requestId || "pending"}`} terminal={taskTerminal} />
            <AgentActivity tools={agentTools} approvals={agentApprovals} workspaceRequired={workspaceRequired} status={agentStatus}
              onApprove={(id, allowed) => void approveTool(id, allowed)} onChooseWorkspace={() => void chooseWorkspace()} onCancelWorkspace={() => void cancelWorkspace()} />
            {(replyStatus === "failed" || replyStatus === "cancelled") ? (
              <ReplyStatusCard
                tone={replyStatus}
                message={replyError}
                onRetry={() => { setPrompt(currentPrompt); promptInputRef.current?.focus(); }}
                onOpenSettings={openModelSettings}
              />
            ) : null}
          </div>
        )}
      </section>

      {selectedFavorite && (
        <HtmlFavoriteDialog
          favorite={selectedFavorite}
          returnFocusRef={favoritesButtonRef}
          onClose={() => setSelectedFavoriteId(null)}
          onToggleFavorite={() => void toggleFavorite(selectedFavorite.html, selectedFavorite.sourceChatId ?? undefined).catch((error) => toast.error(toUserMessage(error, "收藏失败，请重试。")))}
        />
      )}

      {/* Layer 3: Input Zone */}
      <div className="bubble-input-zone">
        {hasInputContext && (
          <div className="bubble-input-zone__chips">
            {attachment && (
              <div className="bubble-input-zone__chip">
                <span className="bubble-input-zone__chip-text">
                  📄 {attachment.displayName} · {formatBytes(attachment.byteSize)}
                </span>
                <button type="button" className="bubble-input-zone__chip-remove" aria-label="移除附件" onClick={() => void clearAttachment()}>
                  ✕
                </button>
              </div>
            )}
            {screenshot && (
              <div className="bubble-input-zone__chip">
                <img src={screenshot.dataUrl} alt="" className="bubble-input-zone__chip-thumb" />
                <span className="bubble-input-zone__chip-text">截图 {screenshot.width}×{screenshot.height}</span>
                <button type="button" className="bubble-input-zone__chip-remove" aria-label="移除截图" onClick={() => void clearScreenshot()}>
                  ✕
                </button>
              </div>
            )}
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
        <div className="chat-workspace" aria-label="对话上下文">
          <button type="button" className="chat-workspace__directory" title={conversation.cwd || "需要操作本地文件时再选择文件夹"} disabled={!isTauriRuntime || agentBusy} onClick={() => void chooseWorkspace()}>
            📁 {conversation.cwd ? (conversation.cwd.split(/[\\/]/).filter(Boolean).pop() || conversation.cwd) : "选择工作目录（可选）"}
          </button>
          <button ref={favoritesButtonRef} type="button" className="chat-workspace__directory" title="收藏的 HTML 卡片" onClick={() => setFavoritesOpen((open) => !open)} aria-expanded={favoritesOpen}>
            <Star size={13} /> 收藏卡片{favorites.length ? ` · ${favorites.length}` : ""}
          </button>
          <button type="button" disabled={agentBusy} onClick={newConversation}>新对话</button>
        </div>
        {favoritesOpen && (
          <div className="bubble-favorites" aria-label="收藏的 HTML 卡片">
            {favorites.length === 0 ? (
              <p>还没有收藏，在任意 HTML 卡片头部点 ★ 即可收藏</p>
            ) : favorites.map((favorite) => (
              <div key={favorite.id} className="bubble-favorites__item">
                <button
                  type="button"
                  className="bubble-favorites__title"
                  title={favorite.html}
                  onClick={() => { setSelectedFavoriteId(favorite.id); setFavoritesOpen(false); }}
                >
                  {favorite.title}
                </button>
                <span className="bubble-favorites__actions">
                  <button type="button" title="删除" onClick={() => void removeFavorite(favorite.id).then(() => {
                    if (selectedFavoriteId === favorite.id) setSelectedFavoriteId(null);
                  }).catch((error) => toast.error(toUserMessage(error, "删除失败，请重试。")))}>
                    <X size={13} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        <form className="prompt-form" onSubmit={submit}>
          <div className="prompt-tools" aria-label="输入工具">
            <button type="button" onClick={() => void chooseAttachment()} aria-label="选择文件" title="选择文件">
              <Paperclip size={17} />
            </button>
            <button type="button" onClick={() => runCommand("begin_screen_capture")} aria-label="截图提问" title="截图提问">
              <ScanLine size={17} />
            </button>
            <button
              type="button"
              className={isListening ? "is-active" : ""}
              disabled={isTranscribingVoice}
              onClick={() => void toggleVoiceInput()}
              aria-label={isListening ? "停止语音输入" : isTranscribingVoice ? "正在转写语音" : "开始语音输入"}
              title={isListening ? "停止语音输入" : isTranscribingVoice ? "正在转写语音" : "语音输入"}
            >
              {isListening ? <Square size={14} /> : <Mic size={17} />}
            </button>
          </div>
          <input
            ref={promptInputRef}
            value={prompt}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            placeholder={attachment || screenshot ? "可补充处理要求" : "输入问题，或描述一个任务"}
            aria-label="发送给 Piko 的问题"
          />
          {agentBusy && <button type="submit" aria-label="补充要求" disabled={!prompt.trim() || sendingSteering}>补充要求</button>}
          {(isThinking || agentBusy) ? (
            <button type="button" className="prompt-form__stop" onClick={cancel} title="停止生成" aria-label="停止生成">
              <Square size={15} />
            </button>
          ) : (
            <button type="submit" aria-label="发送消息" disabled={!prompt.trim() && !attachment && !screenshot}>
              <ArrowUp size={19} />
            </button>
          )}
        </form>
      </div>

      {contextNotice && <p className="bubble-context-note" role="status">{contextNotice}</p>}
    </main>
  );
}
