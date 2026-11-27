import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { isTauriRuntime, runCommand } from "../app/appRuntime";
import { toUserMessage } from "../../lib/errors";
import { useStableEvent } from "../../hooks/useStableEvent";
import { useToast } from "../../components/feedback/toastStore";
import { useTranslation } from "../i18n/I18nProvider";
import { useAgentTask } from "./useAgentTask";
import { useTaskEventBridge } from "./useTaskEventBridge";
import { getConfirmationChoices } from "./ActionConfirmationCard";
import { invokeV2 } from "./agentWire";
import { dropQueuedTask, enqueueQueuedTask, takeQueueHead, type QueuedTask } from "./taskQueues";
import type { TaskRecord } from "./taskOutcomeModel";
import {
  CONVERSATION_STORAGE, loadConversation,
  type AgentPolicy, type AgentStartInputV2, type ContractObject, type Conversation, type GitMode, type SteerMode,
} from "./agentTypes";
import type { ActionDraft } from "./chatTypes";
import type { ConversationView } from "./conversationView";
import type { AttachmentAction, AttachmentPreview, ChatHistoryEntry, ScreenshotPreview } from "../../types/appTypes";

type ChatStreamOptions = {
  tabId?: string;
  attachment: AttachmentPreview | undefined;
  attachmentAction: AttachmentAction;
  attachmentContext: { contextId: string } | undefined;
  screenshot: ScreenshotPreview | undefined;
  /** 会话草稿恢复完成信号，发送前必须等它落定。 */
  viewReady: MutableRefObject<Promise<unknown>>;
  /** 取走当前主动消息回应身份：发送一次后即失效。 */
  takeSoulReplyId: () => string | null;
  onNewConversation?: () => void;
};

/**
 * 会话流式状态维度：草稿、发送/停止、队列与插话、操作确认、任务恢复与协议事件接线。
 * 该 hook 不渲染 UI，窗口组件按其暴露的状态装配气泡区域。
 */
export function useChatStream({
  tabId, attachment, attachmentAction, attachmentContext, screenshot, viewReady, takeSoulReplyId, onNewConversation,
}: ChatStreamOptions) {
  const toast = useToast();
  const { t } = useTranslation();
  const agent = useAgentTask();
  const {
    agentBusy, agentStatus, agentTools, taskTerminal, agentApprovals, workspaceRequired,
    agentPendingContract, agentMilestones, agentNotices, agentReceipt,
    setAgentBusy, beginAgentTask, resetAgentTask, restoreAgentTask, applyAgentEvent, setAgentPendingContract,
  } = agent;

  const [prompt, setPrompt] = useState("");
  const lastTypingAt = useRef(0);
  const [conversation, setConversation] = useState<Conversation>(() => {
    if (!tabId) return loadConversation();
    try {
      const saved = JSON.parse(localStorage.getItem(`${CONVERSATION_STORAGE}:${tabId}`) || "null");
      if (saved?.id === tabId && typeof saved.cwd === "string" && Array.isArray(saved.turnIds)) return { ...saved, importHistory: false };
    } catch { /* Optional session metadata. */ }
    return { id: tabId, cwd: "", importHistory: false, turnIds: [] };
  });
  const conversationRef = useRef(conversation);
  const contextReset = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => { conversationRef.current = conversation; }, [conversation]);
  const [verificationOf, setVerificationOf] = useState<string>();
  const [resumeOf, setResumeOf] = useState<string>();
  const [steerMode, setSteerMode] = useState<SteerMode>("redirect");
  const [contractBusy, setContractBusy] = useState(false);
  const [taskKind, setTaskKind] = useState<"companion" | "coding">("companion");
  // 委托任务判定：start 时记录 taskKind；恢复的旧快照则以协议 v2 事件的出现为准。
  const codingTask = taskKind === "coding" || agentMilestones.length > 0 || Boolean(agentPendingContract);
  const [sendingSteering, setSendingSteering] = useState(false);
  const steeringPendingRef = useRef(false);
  const agentBusyRef = useRef(false);
  // P2（doc 18 §9）：guidance 在途的本地排队与 busy 期间的新任务排队（内存态，每会话独立）。
  const [guidanceQueue, setGuidanceQueue] = useState<string[]>([]);
  const guidanceQueueRef = useRef<string[]>([]);
  const [taskQueue, setTaskQueue] = useState<QueuedTask[]>([]);
  const taskQueueRef = useRef<QueuedTask[]>([]);
  const [queueNext, setQueueNext] = useState(false);
  const displayedRequestIdRef = useRef<string | undefined>(undefined);
  const businessActionRef = useRef(false);
  const agentReadyRef = useRef<Promise<unknown>>(Promise.resolve());
  const [taskStateLoaded, setTaskStateLoaded] = useState(!isTauriRuntime);
  useEffect(() => { try { localStorage.setItem(tabId ? `${CONVERSATION_STORAGE}:${tabId}` : CONVERSATION_STORAGE, JSON.stringify(conversation)); } catch { /* Optional. */ } }, [conversation, tabId]);

  const [message, setMessage] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  /**
   * 回复状态机（02 §4）：thinking / streaming 时是 null，结束后落到 done / failed / cancelled。
   * 失败与停止都**不再把错误塞进 message**——那会让错误以 Markdown 正文的样子出现。
   */
  const [replyStatus, setReplyStatus] = useState<"done" | "failed" | "cancelled" | null>(null);
  const [replyError, setReplyError] = useState("");
  /** thinking 超过 8s 给一句安抚（02 §4）。 */
  const [isThinkingLong, setIsThinkingLong] = useState(false);
  const [requestId, setRequestId] = useState<string>();
  const [pendingAction, setPendingAction] = useState<ActionDraft>();
  const [selectedChoiceIndexes, setSelectedChoiceIndexes] = useState<number[]>([]);
  const [pendingPromptSummary, setPendingPromptSummary] = useState({ length: 0, hasAttachment: false, hasScreenshot: false });
  const [showReplySkeleton, setShowReplySkeleton] = useState(false);
  const [isReplyEntering, setIsReplyEntering] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatHistoryEntry[]>([]);
  const [historyError, setHistoryError] = useState("");
  const historyGeneration = useRef(0);
  const [currentPrompt, setCurrentPrompt] = useState("");
  const [contextNotice, setContextNotice] = useState("");
  const activeRequestIdRef = useRef<string | undefined>(undefined);
  const lastSequenceRef = useRef(0);
  const mountedRef = useRef(true);
  const previewReplyTimer = useRef<number | undefined>(undefined);
  const thinkingLongTimer = useRef<number | undefined>(undefined);
  const skeletonHideTimer = useRef<number | undefined>(undefined);
  const receivedFirstDeltaRef = useRef(false);
  const confirmationChoices = pendingAction ? getConfirmationChoices(pendingAction) : [];

  const clearSkeletonHideTimer = useStableEvent(() => {
    if (thinkingLongTimer.current) {
      window.clearTimeout(thinkingLongTimer.current);
      thinkingLongTimer.current = undefined;
    }
    if (skeletonHideTimer.current) {
      window.clearTimeout(skeletonHideTimer.current);
      skeletonHideTimer.current = undefined;
    }
  });

  const hideSkeletonSoon = useStableEvent(() => {
    clearSkeletonHideTimer();
    skeletonHideTimer.current = window.setTimeout(() => {
      setShowReplySkeleton(false);
      setIsReplyEntering(false);
      skeletonHideTimer.current = undefined;
    }, 220);
  });

  const refreshChatHistory = useStableEvent(() => {
    if (!isTauriRuntime) return;
    const generation = ++historyGeneration.current;
    const history = tabId
      ? runCommand("conversation_chat_history", { conversationId: tabId }, [])
      : runCommand("get_bubble_chat_history", undefined, []);
    void history.then((entries) => {
      if (!mountedRef.current || generation !== historyGeneration.current) return;
      setHistoryError("");
      if (entries) { const current = conversationRef.current; setChatHistory((tabId || current.importHistory ? entries : entries.filter((entry) => current.turnIds.includes(entry.id))).filter((entry) => entry.id !== displayedRequestIdRef.current)); }
    }).catch(error => {
      if (mountedRef.current && generation === historyGeneration.current) setHistoryError(toUserMessage(error, "对话历史加载失败，请重试。"));
    });
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    refreshChatHistory();
  }, [refreshChatHistory]);

  useEffect(() => {
    return () => {
      clearSkeletonHideTimer();
      if (previewReplyTimer.current) window.clearTimeout(previewReplyTimer.current);
    };
  }, [clearSkeletonHideTimer]);

  // 两个稳定回调互相调用（发送失败续发队列），用 ref 打破声明顺序上的循环。
  const pumpGuidanceQueueRef = useRef<() => void>(() => {});
  /** guidance steer 发送：置位在途标志后异步下发；失败回滚并尝试续发队列。 */
  const sendGuidanceSteer = useStableEvent((text: string) => {
    const target = activeRequestIdRef.current;
    if (!target) return;
    steeringPendingRef.current = true; setSendingSteering(true);
    void runCommand("agent_steer", { requestId: target, text, mode: "guidance" as SteerMode }).catch((error) => {
      steeringPendingRef.current = false; setSendingSteering(false);
      toast.error(toUserMessage(error, "补充要求未送达，请重试"));
      pumpGuidanceQueueRef.current();
    });
  });
  /** 前一条 guidance 被 steering-accepted 后按序发送下一条（doc 18 §9）。 */
  const pumpGuidanceQueue = useStableEvent(() => {
    if (steeringPendingRef.current || !guidanceQueueRef.current.length) return;
    const [head, ...rest] = guidanceQueueRef.current;
    guidanceQueueRef.current = rest;
    setGuidanceQueue(rest);
    sendGuidanceSteer(head);
  });
  useEffect(() => { pumpGuidanceQueueRef.current = pumpGuidanceQueue; }, [pumpGuidanceQueue]);
  const enqueueQueuedPrompt = useStableEvent((text: string) => {
    const result = enqueueQueuedTask(taskQueueRef.current, text, crypto.randomUUID());
    if (!result.accepted) {
      toast.error(t("chat.task.queue.full", "排队已达上限（5 条），请等任务结束后再发送。"));
      return;
    }
    taskQueueRef.current = result.queue;
    setTaskQueue(result.queue);
  });
  const removeQueuedTask = useStableEvent((id: string) => {
    taskQueueRef.current = dropQueuedTask(taskQueueRef.current, id);
    setTaskQueue(taskQueueRef.current);
  });
  /** 任务终态后自动发送队首；队列是内存态，不参与快照恢复。 */
  const pumpTaskQueue = useStableEvent(() => {
    const { head, queue } = takeQueueHead(taskQueueRef.current);
    if (!head) return;
    taskQueueRef.current = queue;
    setTaskQueue(queue);
    void sendPrompt(head.text, null, null, true);
  });
  /** 时间线批注：作为 guidance steer 发送，固定“【批注】”前缀区分来源。 */
  const annotateTask = useStableEvent((text: string) => {
    const body = `【批注】${text}`;
    if (!activeRequestIdRef.current) {
      toast.info(t("chat.task.log.annotationClosed", "任务已结束，批注未发送。"));
      return;
    }
    if (steeringPendingRef.current) {
      guidanceQueueRef.current = [...guidanceQueueRef.current, body];
      setGuidanceQueue(guidanceQueueRef.current);
      return;
    }
    sendGuidanceSteer(body);
  });
  /** 契约等待中断的任务：sidecar 已死，续跑无意义，以原 prompt/原目录发起新任务。 */
  const restartTask = useStableEvent((record: TaskRecord) => {
    if (agentBusyRef.current) return;
    const recordPrompt = (record.prompt || "").trim();
    if (!recordPrompt) {
      toast.info(t("chat.task.history.restartMissing", "缺少原始任务信息，无法重新发起。"));
      return;
    }
    setVerificationOf(undefined); setResumeOf(undefined);
    const next = { ...conversationRef.current, cwd: record.cwd || conversationRef.current.cwd, knowledgeScope: undefined, importHistory: false, turnIds: [] };
    conversationRef.current = next; setConversation(next); setChatHistory([]);
    void sendPrompt(recordPrompt, null, null);
  });

  async function sendPrompt(currentPromptValue: string, inspectionTarget: string | null = verificationOf ?? null, resumeTarget: string | null = resumeOf ?? null, keepDraft = false) {
    try {
      await contextReset.current;
      await viewReady.current;
    } catch (error) {
      toast.error(toUserMessage(error, "新对话上下文清理失败，请重新开启新对话。"));
      return;
    }
    try { await agentReadyRef.current; }
    catch (error) { toast.error(toUserMessage(error, "任务状态恢复失败，请重新打开聊天窗口。")); return; }
    if (agentBusyRef.current || (!currentPromptValue.trim() && !attachment && !screenshot)) return;

    const requestPrompt = currentPromptValue.trim();
    const replyingTo = takeSoulReplyId();
    if (displayedRequestIdRef.current && (currentPrompt || message)) {
      const previous = { id: displayedRequestIdRef.current, prompt: currentPrompt, response: message, createdAt: Math.floor(Date.now() / 1000) };
      setChatHistory((entries) => [...entries.filter((entry) => entry.id !== previous.id), previous]);
    }
    const currentRequestId = crypto.randomUUID();
    displayedRequestIdRef.current = currentRequestId;
    const currentConversation = conversationRef.current;
    const nextConversation = { ...currentConversation, id: currentConversation.id || currentRequestId, turnIds: [...currentConversation.turnIds, currentRequestId] };
    conversationRef.current = nextConversation;
    setConversation(nextConversation);
    resetAgentTask();
    businessActionRef.current = false;

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
    receivedFirstDeltaRef.current = false;
    clearSkeletonHideTimer();
    setPendingPromptSummary({
      length: requestPrompt.length,
      hasAttachment: Boolean(attachment),
      hasScreenshot: Boolean(screenshot),
    });
    setContextNotice("");
    activeRequestIdRef.current = currentRequestId;
    setRequestId(currentRequestId);
    setPrompt(keepDraft ? prompt : "");

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

    beginAgentTask(currentRequestId); agentBusyRef.current = true;
    setSteerMode("redirect");
    // 绑定了项目的会话按委托式编码任务启动（doc 04 §4.6）；验收命令与档位由宿主按项目配置裁决。
    const projectStart: AgentStartInputV2 = nextConversation.projectId
      ? { taskKind: "coding", projectId: nextConversation.projectId }
      : {};
    setTaskKind(projectStart.taskKind ?? "companion");
    const startInput = {
      requestId: currentRequestId,
      conversationId: nextConversation.id, knowledgeScope: nextConversation.knowledgeScope, cwd: nextConversation.cwd || undefined, unified: true, importHistory: nextConversation.importHistory,
      prompt: requestPrompt,
      attachmentAction: attachment ? attachmentAction : undefined,
      ...attachmentContext,
      screenshot: tabId ? screenshot : undefined,
      includeScreenshot: Boolean(screenshot),
      verificationOf: inspectionTarget || undefined,
      resumeOf: resumeTarget || undefined,
      proactiveMessageId: replyingTo || undefined,
      ...projectStart,
    };
    void agentReadyRef.current.then(() => runCommand("agent_start", { input: startInput })).catch((error) => {
      applyAgentEvent({ type: "failed", requestId: currentRequestId });
      agentBusyRef.current = false;
      setPrompt(requestPrompt);
      setIsThinking(false);
      setShowReplySkeleton(false);
      setReplyStatus("failed");
      setReplyError(toUserMessage(error, "网络好像不太稳定"));
      pumpTaskQueue();
    });
  }

  function submitPrompt() {
    if (agentBusyRef.current) {
      const text = prompt.trim();
      if (!text || !activeRequestIdRef.current) return;
      // 排队模式（doc 18 §9）：busy 期间的新任务入本地队列，终态后自动发送队首。
      if (queueNext) {
        enqueueQueuedPrompt(text);
        setPrompt("");
        return;
      }
      // guidance 在途时入本地队列按序发送（前一条 steering-accepted 后发下一条）。
      if (steerMode === "guidance") {
        if (steeringPendingRef.current) {
          guidanceQueueRef.current = [...guidanceQueueRef.current, text];
          setGuidanceQueue(guidanceQueueRef.current);
          setPrompt("");
          return;
        }
        sendGuidanceSteer(text);
        return;
      }
      // redirect：保持立即注入/在途拒绝语义，不排队。
      if (steeringPendingRef.current) {
        toast.info(t("chat.task.steer.pendingNotice", "上一条插话尚未送达，请稍候再试。"));
        return;
      }
      steeringPendingRef.current = true; setSendingSteering(true);
      // mode 为协议 v2 字段（doc 18 §2）；generated 契约收录前用交叉类型透传。
      const steerArgs: { requestId: string; text: string } & { mode: SteerMode } = { requestId: activeRequestIdRef.current, text, mode: "redirect" };
      void runCommand("agent_steer", steerArgs).catch((error) => { steeringPendingRef.current = false; setSendingSteering(false); toast.error(toUserMessage(error, "补充要求未送达，请重试")); });
      return;
    }
    if (!prompt.trim() && !attachment && !screenshot) return;
    void sendPrompt(prompt.trim());
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

  async function approveTool(id: string, allowed: boolean) {
    if (!activeRequestIdRef.current) return;
    try {
      await runCommand("agent_approve", { requestId: activeRequestIdRef.current, approvalId: id, allowed });
    } catch (error) { toast.error(toUserMessage(error, "确认失败")); }
  }
  /** 契约裁决（doc 18 §2 contract 命令）：approved=false 时任务以 cancelled 收场。 */
  async function resolveContract(approved: boolean, contract: ContractObject, policy: AgentPolicy, gitMode: GitMode) {
    const target = agentPendingContract;
    const targetRequestId = activeRequestIdRef.current;
    if (!target || !targetRequestId || contractBusy) return;
    setContractBusy(true);
    try {
      await invokeV2("agent_confirm_contract", {
        requestId: targetRequestId, contractId: target.contractId, approved, contract, gitMode, policy,
      });
      setAgentPendingContract(null);
    } catch (error) {
      toast.error(toUserMessage(error, "契约确认失败，请重试"));
    } finally {
      setContractBusy(false);
    }
  }
  /** 打回：以 resume_of=原任务 + 反馈文本发起续跑。 */
  function rejectReceipt(receiptRequestId: string, feedback: string) {
    if (agentBusyRef.current) return;
    setVerificationOf(undefined);
    setResumeOf(receiptRequestId);
    void sendPrompt(feedback, null, receiptRequestId);
  }
  function inspectTask(targetId: string) {
    if (agentBusyRef.current) return;
    setResumeOf(undefined); setVerificationOf(targetId);
    void sendPrompt(`请只读核对任务 ${targetId} 的实际执行结果。先确认目标和验收标准，按证据说明哪些已完成、哪些未完成、哪些无法确认，不要重新执行修改。`, targetId, null);
  }

  async function confirmAction() {
    if (!pendingAction) return;
    try {
      if (pendingAction.pluginId === "piko.reminders" && isTauriRuntime && !(await isPermissionGranted())) {
        await requestPermission();
      }
      if (businessActionRef.current) {
        if (!activeRequestIdRef.current) return;
        await runCommand("agent_confirm_action", { requestId: activeRequestIdRef.current, id: pendingAction.id, selectedIndexes: confirmationChoices.length ? selectedChoiceIndexes : undefined });
        return;
      }
      const execution = await runCommand("confirm_chat_action", {
        id: pendingAction.id,
        selectedIndexes: confirmationChoices.length ? selectedChoiceIndexes : undefined,
      });
      setPendingAction(undefined);
      setSelectedChoiceIndexes([]);
      setMessage(execution.message);
      // Execution already returned the authoritative result. A second model
      // request can misclassify that result or propose the same action again.
      activeRequestIdRef.current = undefined;
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
      if (businessActionRef.current) {
        if (!activeRequestIdRef.current) return;
        await runCommand("agent_reject_action", { requestId: activeRequestIdRef.current, id: pendingAction.id });
        return;
      }
      await runCommand("reject_chat_action", { id: pendingAction.id });
      setPendingAction(undefined);
      setSelectedChoiceIndexes([]);
      setMessage("已取消该操作。");
    } catch (error) {
      toast.error(toUserMessage(error, "保存失败，请重试。"));
    }
  }

  async function clearContext() {
    if (onNewConversation) { onNewConversation(); return; }
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

  /** 新对话的会话侧重置；附件、菜单与主动消息由窗口组件一并清理。 */
  function resetSession(cwd: string) {
    contextReset.current = isTauriRuntime
      ? Promise.all([runCommand("clear_text_attachment"), runCommand("clear_screen_capture")])
      : Promise.resolve();
    void contextReset.current.catch(error => toast.error(toUserMessage(error, "新对话上下文清理失败，请重新开启新对话。")));
    setPrompt("");
    setContextNotice("");
    activeRequestIdRef.current = undefined;
    setRequestId(undefined);
    businessActionRef.current = false;
    setSelectedChoiceIndexes([]);
    setVerificationOf(undefined); setResumeOf(undefined);
    displayedRequestIdRef.current = undefined;
    const next = { id: "", cwd, importHistory: false, turnIds: [] };
    conversationRef.current = next; setConversation(next); setChatHistory([]); setCurrentPrompt(""); setMessage("");
    resetAgentTask();
    setReplyStatus(null); setReplyError(""); setPendingAction(undefined);
    guidanceQueueRef.current = []; setGuidanceQueue([]);
    taskQueueRef.current = []; setTaskQueue([]);
    setQueueNext(false);
  }

  /** 会话方法集合：组件通过行为而非可变 ref 访问会话内部状态。 */
  const markTyping = useStableEvent(() => { lastTypingAt.current = Date.now(); });
  const isTypingRecently = useStableEvent(() => Date.now() - lastTypingAt.current < 5000);
  const isAgentBusy = useStableEvent(() => agentBusyRef.current);
  const getAgentReady = useStableEvent(() => agentReadyRef.current);
  const getDisplayedRequestId = useStableEvent(() => displayedRequestIdRef.current);
  const replaceConversation = useStableEvent((next: Conversation) => {
    conversationRef.current = next;
    setConversation(next);
  });
  /** 浏览器预览：恢复上次的预览轮次，必要时重放预览回复。 */
  const restorePreviewTurn = useStableEvent((turn: NonNullable<ConversationView["previewTurn"]>) => {
    setChatHistory(turn.history || []);
    setCurrentPrompt(turn.prompt || "");
    setMessage(turn.response || "");
    setReplyStatus(turn.status);
    displayedRequestIdRef.current = turn.requestId;
    if (!turn.thinking) return;
    setIsThinking(true);
    setShowReplySkeleton(true);
    previewReplyTimer.current = window.setTimeout(() => {
      previewReplyTimer.current = undefined;
      setMessage(`这是浏览器预览回复：${turn.prompt}`);
      setReplyStatus("done"); setIsThinking(false); setShowReplySkeleton(false);
    }, 450);
  });

  useTaskEventBridge({
    tabId,
    agent: { applyAgentEvent, restoreAgentTask, setAgentBusy },
    refs: {
      conversationRef, activeRequestIdRef, displayedRequestIdRef, lastSequenceRef, receivedFirstDeltaRef,
      agentBusyRef, steeringPendingRef, businessActionRef, guidanceQueueRef, agentReadyRef,
    },
    state: {
      setPrompt, setMessage, setCurrentPrompt, setRequestId, setIsThinking, setShowReplySkeleton, setIsReplyEntering,
      setReplyStatus, setReplyError, setPendingAction, setSelectedChoiceIndexes, setSendingSteering,
      setGuidanceQueue, setContextNotice, setTaskStateLoaded, setConversation, setChatHistory,
    },
    callbacks: { refreshChatHistory, hideSkeletonSoon, clearSkeletonHideTimer, pumpGuidanceQueue, pumpTaskQueue },
  });

  return {
    prompt, setPrompt, markTyping, isTypingRecently,
    conversation, setConversation, replaceConversation, restorePreviewTurn,
    message, setMessage, currentPrompt, setCurrentPrompt, setChatHistory,
    chatHistory, historyError, refreshChatHistory,
    isThinking, setIsThinking, isThinkingLong, replyStatus, setReplyStatus, replyError,
    showReplySkeleton, setShowReplySkeleton, isReplyEntering, pendingPromptSummary,
    pendingAction, selectedChoiceIndexes, setSelectedChoiceIndexes, confirmationChoices,
    steerMode, setSteerMode, sendingSteering, guidanceQueue, taskQueue, queueNext, setQueueNext, removeQueuedTask,
    verificationOf, setVerificationOf, resumeOf, setResumeOf,
    contextNotice, requestId, getDisplayedRequestId, isAgentBusy, getAgentReady, taskStateLoaded, codingTask,
    submitPrompt, cancel, sendPrompt, annotateTask, restartTask, inspectTask, rejectReceipt,
    approveTool, resolveContract, contractBusy, clearContext, resetSession, confirmAction, rejectAction,
    agent, agentBusy, agentStatus, agentTools, taskTerminal, agentApprovals, workspaceRequired,
    agentPendingContract, agentMilestones, agentNotices, agentReceipt,
  };
}

export type ChatStreamApi = ReturnType<typeof useChatStream>;
