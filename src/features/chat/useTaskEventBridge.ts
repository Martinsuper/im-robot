import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauriRuntime, runCommand } from "../app/appRuntime";
import { toUserMessage } from "../../lib/errors";
import { connectAgentTask } from "./agentTaskRecovery";
import { getConfirmationChoices } from "./ActionConfirmationCard";
import type { useAgentTask } from "./useAgentTask";
import type { ActionDraft, ChatEvent } from "./chatTypes";
import type { AgentEvent, AgentTaskSnapshot, Conversation } from "./agentTypes";
import type { ChatHistoryEntry } from "../../types/appTypes";

type AgentTaskApi = ReturnType<typeof useAgentTask>;
type ReplyStatus = "done" | "failed" | "cancelled" | null;

export type ChatStreamRefs = {
  conversationRef: MutableRefObject<Conversation>;
  activeRequestIdRef: MutableRefObject<string | undefined>;
  displayedRequestIdRef: MutableRefObject<string | undefined>;
  lastSequenceRef: MutableRefObject<number>;
  receivedFirstDeltaRef: MutableRefObject<boolean>;
  agentBusyRef: MutableRefObject<boolean>;
  steeringPendingRef: MutableRefObject<boolean>;
  businessActionRef: MutableRefObject<boolean>;
  guidanceQueueRef: MutableRefObject<string[]>;
  agentReadyRef: MutableRefObject<Promise<unknown>>;
};

export type ChatStreamStateSetters = {
  setPrompt: Dispatch<SetStateAction<string>>;
  setMessage: Dispatch<SetStateAction<string>>;
  setCurrentPrompt: Dispatch<SetStateAction<string>>;
  setRequestId: Dispatch<SetStateAction<string | undefined>>;
  setIsThinking: Dispatch<SetStateAction<boolean>>;
  setShowReplySkeleton: Dispatch<SetStateAction<boolean>>;
  setIsReplyEntering: Dispatch<SetStateAction<boolean>>;
  setReplyStatus: Dispatch<SetStateAction<ReplyStatus>>;
  setReplyError: Dispatch<SetStateAction<string>>;
  setPendingAction: Dispatch<SetStateAction<ActionDraft | undefined>>;
  setSelectedChoiceIndexes: Dispatch<SetStateAction<number[]>>;
  setSendingSteering: Dispatch<SetStateAction<boolean>>;
  setGuidanceQueue: Dispatch<SetStateAction<string[]>>;
  setContextNotice: Dispatch<SetStateAction<string>>;
  setTaskStateLoaded: Dispatch<SetStateAction<boolean>>;
  setConversation: Dispatch<SetStateAction<Conversation>>;
  setChatHistory: Dispatch<SetStateAction<ChatHistoryEntry[]>>;
};

export type ChatStreamEventCallbacks = {
  refreshChatHistory: () => void;
  hideSkeletonSoon: () => void;
  clearSkeletonHideTimer: () => void;
  pumpGuidanceQueue: () => void;
  pumpTaskQueue: () => void;
};

type TaskEventBridgeOptions = {
  tabId?: string;
  agent: Pick<AgentTaskApi, "applyAgentEvent" | "restoreAgentTask" | "setAgentBusy">;
  refs: ChatStreamRefs;
  state: ChatStreamStateSetters;
  callbacks: ChatStreamEventCallbacks;
};

/**
 * 会话流式状态协议层：chat-event 与 agent-event 双通道订阅、快照恢复与事件翻译。
 * 只把协议事件翻译成状态写入，不渲染任何 UI。
 */
export function useTaskEventBridge({ tabId, agent, refs, state, callbacks }: TaskEventBridgeOptions) {
  const { applyAgentEvent, restoreAgentTask, setAgentBusy } = agent;
  const {
    conversationRef, activeRequestIdRef, displayedRequestIdRef, lastSequenceRef, receivedFirstDeltaRef,
    agentBusyRef, steeringPendingRef, businessActionRef, guidanceQueueRef, agentReadyRef,
  } = refs;
  const {
    setPrompt, setMessage, setCurrentPrompt, setRequestId, setIsThinking, setShowReplySkeleton, setIsReplyEntering,
    setReplyStatus, setReplyError, setPendingAction, setSelectedChoiceIndexes, setSendingSteering,
    setGuidanceQueue, setContextNotice, setTaskStateLoaded, setConversation, setChatHistory,
  } = state;
  const { refreshChatHistory, hideSkeletonSoon, clearSkeletonHideTimer, pumpGuidanceQueue, pumpTaskQueue } = callbacks;

  useEffect(() => {
    if (!isTauriRuntime) return;

    const onChatEvent = (event: { payload: ChatEvent }) => {
      if (event.payload.requestId !== activeRequestIdRef.current) return;

      if (event.payload.type === "started") {
        lastSequenceRef.current = 0;
        receivedFirstDeltaRef.current = false;
        setMessage("");
        setShowReplySkeleton(true);
        setIsReplyEntering(false);
      }
      if (event.payload.type === "delta") {
        if (event.payload.sequence <= lastSequenceRef.current) return;
        lastSequenceRef.current = event.payload.sequence;
        const { text } = event.payload;
        setIsThinking(false);
        if (!receivedFirstDeltaRef.current) {
          receivedFirstDeltaRef.current = true;
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

    const restoreSnapshot = (snapshot: AgentTaskSnapshot) => {
      const terminal = snapshot.events.find((event) => ["completed", "failed", "cancelled"].includes(event.type));
      const current = conversationRef.current;
      if ((tabId || terminal) && snapshot.conversationId !== current.id) return;
      const sameConversation = current.id === snapshot.conversationId;
      const turnIds = sameConversation ? current.turnIds : [];
      const next = { id: snapshot.conversationId, cwd: snapshot.cwd || "", knowledgeScope: snapshot.knowledgeScope || undefined, importHistory: sameConversation && current.importHistory,
        turnIds: turnIds.includes(snapshot.requestId) ? turnIds : [...turnIds, snapshot.requestId] };
      conversationRef.current = next;
      setConversation(next);
      restoreAgentTask(snapshot);
      displayedRequestIdRef.current = snapshot.requestId;
      activeRequestIdRef.current = terminal ? undefined : snapshot.requestId;
      agentBusyRef.current = !terminal;
      setRequestId(terminal ? undefined : snapshot.requestId);
      setCurrentPrompt(snapshot.prompt);
      setMessage(snapshot.response);
      lastSequenceRef.current = 0;
      receivedFirstDeltaRef.current = Boolean(snapshot.response);
      const proposed = snapshot.events.find((event) => event.type === "action-proposed")?.draft;
      businessActionRef.current = Boolean(proposed);
      setPendingAction(proposed);
      setSelectedChoiceIndexes(proposed ? getConfirmationChoices(proposed).map((choice) => choice.index) : []);
      const waiting = snapshot.events.some((event) => event.type === "approval" || event.type === "workspace-required") || Boolean(proposed);
      const thinking = !terminal && !snapshot.response && !waiting;
      setIsThinking(thinking);
      clearSkeletonHideTimer();
      setShowReplySkeleton(thinking);
      setIsReplyEntering(false);
      setReplyStatus(terminal?.type === "completed" ? "done" : terminal?.type === "failed" ? "failed" : terminal?.type === "cancelled" ? "cancelled" : null);
      setReplyError(terminal?.type === "failed" ? terminal.message || "处理失败" : "");
      setChatHistory((entries) => entries.filter((entry) => entry.id !== snapshot.requestId));
    };
    const connection = connectAgentTask({
      subscribe: (onEvent) => listen<AgentEvent>("agent-event", ({ payload }) => onEvent(payload)),
      getSnapshot: () => runCommand("agent_get_task_snapshot", tabId ? { conversationId: tabId } : undefined, null) as Promise<AgentTaskSnapshot | null>,
      restore: restoreSnapshot,
      onEvent: (event) => {
        if (event.requestId !== activeRequestIdRef.current && event.conversationId && (!tabId || event.conversationId === conversationRef.current.id) && event.prompt !== undefined
          && ["started", "completed", "failed", "cancelled"].includes(event.type)) {
          restoreSnapshot({ requestId: event.requestId, conversationId: event.conversationId, knowledgeScope: event.knowledgeScope, cwd: event.cwd || null,
            prompt: event.prompt, response: event.response || "", eventSequence: event.eventSequence || 0,
            events: event.type === "started" ? [] : [event] });
        }
        if (event.requestId !== activeRequestIdRef.current) return;
        applyAgentEvent(event);
        if (event.type === "started") { onChatEvent({ payload: { type: "started", requestId: event.requestId, working: false } }); return; }
        if (event.type === "delta") {
          onChatEvent({ payload: { type: "delta", requestId: event.requestId, sequence: lastSequenceRef.current + 1, text: event.text || "" } }); return;
        }
        if (event.type === "tool-start") {
          setShowReplySkeleton(false); clearSkeletonHideTimer(); setIsThinking(false);
        }
        if (event.type === "approval" && event.approvalId) {
          setShowReplySkeleton(false); clearSkeletonHideTimer(); setIsThinking(false);
        }
        if (event.type === "contract-proposed") {
          setShowReplySkeleton(false); clearSkeletonHideTimer(); setIsThinking(false);
        }
        if (event.type === "steering-accepted") {
          steeringPendingRef.current = false; setSendingSteering(false);
          setPrompt((current) => current.trim() === event.text?.trim() ? "" : current);
          setPendingAction(undefined); businessActionRef.current = false;
          setCurrentPrompt((current) => `${current}\n补充要求：${event.text || ""}`);
          pumpGuidanceQueue();
        }
        if (event.type === "workspace-required") {
          setShowReplySkeleton(false); clearSkeletonHideTimer(); setIsThinking(false);
        }
        if (event.type === "action-proposed" && event.draft) {
          businessActionRef.current = true;
          onChatEvent({ payload: { type: "action-proposed", requestId: event.requestId, draft: event.draft } });
        }
        if (event.type === "action-resolved") {
          setPendingAction(undefined); setSelectedChoiceIndexes([]); businessActionRef.current = false;
        }
        if (event.type === "workspace-resolved" && event.cwd) {
          setConversation((current) => ({ ...current, cwd: event.cwd! }));
        }
        if (event.type === "protocol-error") setReplyError(event.message || "通信失败");
        if (event.type === "completed" || event.type === "cancelled" || event.type === "failed") {
          agentBusyRef.current = false;
          setPendingAction(undefined); businessActionRef.current = false;
          steeringPendingRef.current = false; setSendingSteering(false);
          if (event.type === "completed") setReplyStatus("done");
          onChatEvent({ payload: event.type === "failed" ? { type: "failed", requestId: event.requestId, message: event.message || "处理失败" } : { type: event.type, requestId: event.requestId } });
          activeRequestIdRef.current = undefined; setRequestId(undefined);
          // 终态后（doc 18 §9）：排队的补充要求随任务失效；排队的新任务自动接续发送。
          if (guidanceQueueRef.current.length) { guidanceQueueRef.current = []; setGuidanceQueue([]); }
          pumpTaskQueue();
        }
      },
    });
    agentReadyRef.current = connection.ready;
    void connection.ready.then(() => setTaskStateLoaded(true), () => {});
    let disposed = false;
    void connection.ready.catch((error) => {
      if (!disposed) setContextNotice(toUserMessage(error, "任务状态恢复失败，请重新打开聊天窗口。"));
    });

    return () => {
      disposed = true;
      connection.dispose();
      void unlisten.then((dispose) => dispose());
    };
  }, [activeRequestIdRef, agentBusyRef, agentReadyRef, applyAgentEvent, businessActionRef, clearSkeletonHideTimer, conversationRef,
    displayedRequestIdRef, guidanceQueueRef, hideSkeletonSoon, lastSequenceRef, pumpGuidanceQueue, pumpTaskQueue, receivedFirstDeltaRef,
    refreshChatHistory, restoreAgentTask, setAgentBusy, setChatHistory, setContextNotice, setConversation, setCurrentPrompt,
    setIsReplyEntering, setIsThinking, setMessage, setPendingAction, setPrompt, setReplyError, setReplyStatus, setSelectedChoiceIndexes,
    setSendingSteering, setShowReplySkeleton, setTaskStateLoaded, setRequestId, setGuidanceQueue, steeringPendingRef, tabId]);
}
