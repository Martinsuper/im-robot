import { loadConversationView, saveConversationView, type ConversationView } from "./conversationView";
import { useConversationSurface } from "./useConversationSurface";
import { parseAppSettings, useAppSettings } from "../app/settingsStore";
import { useStableEvent } from "../../hooks/useStableEvent";
import { HtmlFavoriteDialog } from "./HtmlFavoriteDialog";
import { BubbleComposer } from "./BubbleComposer";
import { BubbleThread } from "./BubbleThread";
import { BubbleTopbar } from "./BubbleTopbar";
import { WorkspaceDivider } from "./WorkspaceDivider";
import { useChatAttachments } from "./useChatAttachments";
import { useChatStream } from "./useChatStream";
import { useSoulMessages } from "./useSoulMessages";
import { useVoiceControl } from "./useVoiceControl";
import { useWorkspaceInteraction } from "./useWorkspaceInteraction";
import { useWorkspaceSelection } from "./useWorkspaceSelection";
import { useHtmlFavorites } from "./htmlFavorites";
import type { HtmlPreviewView } from "./HtmlPreviewFrame";
import { ACTIVITY_HEARTBEAT_SECONDS, currentActivitySnapshot, reportSoulActivity } from "../soul/proactiveBridge";
import { isTauriRuntime, runCommand } from "../app/appRuntime";
import { defaultAppSettings } from "../app/appShared";
import { useToast } from "../../components/feedback/toastStore";
import { toUserMessage } from "../../lib/errors";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openPath } from "@tauri-apps/plugin-opener";
import { save } from "@tauri-apps/plugin-dialog";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { PanelTab, VoiceAssistantEvent } from "../../types/appTypes";

const PanelWindow = lazy(() => import("../panel/PanelWindow").then((module) => ({ default: module.PanelWindow })));

export type ConversationTabState = { title: string; busy: boolean; waiting: boolean; status: string };
type BubbleWindowProps = {
  conversationTitle?: string;
  onWorkspaceState?: (id: string, tab: PanelTab | null) => void;
  navigationRequest?: { tab: PanelTab; id: number };
  initialWorkspaceOpen?: boolean;
  tabId?: string;
  active?: boolean;
  onNewConversation?: () => void;
  onTabState?: (id: string, state: ConversationTabState) => void;
  onDetach?: () => Promise<void>;
  onReturn?: () => Promise<void>;
  onResumeConversation?: (record: { requestId: string; conversationId: string }) => void;
  resumeRequest?: string;
  onResumeConsumed?: () => void;
};

/**
 * 气泡窗口装配层：只负责组合工作区、附件、语音、会话流式与线程/输入区子组件。
 * 具体职责见 useWorkspaceInteraction / useChatAttachments / useVoiceControl / useChatStream。
 */
export function BubbleWindow({ onWorkspaceState, conversationTitle, navigationRequest, initialWorkspaceOpen = false, tabId, active = true, onNewConversation, onTabState, onDetach, onReturn, onResumeConversation, resumeRequest, onResumeConsumed }: BubbleWindowProps = {}) {
  const activeTabRef = useRef(active);
  useEffect(() => { activeTabRef.current = active; }, [active]);
  const toast = useToast();
  const surface = useConversationSurface((error) => toast.error(toUserMessage(error, "窗口切换失败，请重试。")));
  const { settings: sharedSettings, applyServer } = useAppSettings();
  const promptInputRef = useRef<HTMLTextAreaElement>(null);
  const threadScrollRef = useRef<HTMLDivElement>(null);
  const followThreadRef = useRef(true);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const viewReady = useRef<Promise<unknown>>(Promise.resolve());
  const viewSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const viewLeaving = useRef(false);
  const [viewLoaded, setViewLoaded] = useState(!tabId);
  const [handoffPending, setHandoffPending] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [pinPending, setPinPending] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [selectedFavoriteId, setSelectedFavoriteId] = useState<string | null>(null);
  const [knowledgeProjects, setKnowledgeProjects] = useState<string[]>([]);
  const [expandedHistoryIds, setExpandedHistoryIds] = useState<Set<string>>(new Set());
  const [historySourceIds, setHistorySourceIds] = useState<Set<string>>(new Set());
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [memoryActivity, setMemoryActivity] = useState("");
  const [voiceEvent, setVoiceEvent] = useState<VoiceAssistantEvent | null>(null);
  const favoritesButtonRef = useRef<HTMLButtonElement>(null);

  const attachments = useChatAttachments({ tabId, activeTabRef, promptInputRef, toast });
  const soul = useSoulMessages({ active });
  const session = useChatStream({
    tabId,
    attachment: attachments.attachment,
    attachmentAction: attachments.attachmentAction,
    attachmentContext: attachments.attachmentContext,
    screenshot: attachments.screenshot,
    viewReady,
    takeSoulReplyId: () => {
      const replyId = soul.soulReplyId;
      soul.setSoulReplyId(null);
      return replyId;
    },
    onNewConversation,
  });
  const voice = useVoiceControl({ message: session.message, setPrompt: session.setPrompt, activeTabRef, promptInputRef, toast });
  const stopVoiceRecording = voice.stopVoiceRecording;
  const { isAgentBusy, isTypingRecently, getAgentReady, getDisplayedRequestId, replaceConversation, restorePreviewTurn } = session;
  const workspace = useWorkspaceInteraction({
    surface, active, activeTabRef, tabId, initialWorkspaceOpen, navigationRequest, onWorkspaceState, promptInputRef,
  });
  const { favorites, toggle: toggleFavorite, remove: removeFavorite } = useHtmlFavorites();
  const { companionName, theme, htmlPreviewEnabled } = sharedSettings;
  const aiConfigured = sharedSettings.hasApiKey || /localhost|127\.0\.0\.1/.test(sharedSettings.ai.baseUrl);
  const { chooseWorkspace, cancelWorkspace } = useWorkspaceSelection(session.requestId, session.workspaceRequired, session.setConversation);

  /** 会话草稿：跨窗口切换时保存输入、附件与预览轮次。 */
  const currentView = useStableEvent(() => ({ prompt: session.prompt, cwd: session.conversation.cwd, knowledgeScope: session.conversation.knowledgeScope,
    attachmentAction: attachments.attachmentAction, attachment: attachments.attachment ?? null, screenshot: attachments.screenshot ?? null,
    previewTurn: isTauriRuntime ? undefined : { history: session.chatHistory, prompt: session.currentPrompt, response: session.message, requestId: getDisplayedRequestId(), thinking: session.isThinking, status: session.replyStatus } }));
  const saveViewNow = useStableEvent(() => {
    if (!tabId) return Promise.resolve();
    const view = currentView();
    const saving = viewSaveQueue.current.catch(() => {}).then(() => viewLeaving.current ? undefined : saveConversationView(tabId, view));
    viewSaveQueue.current = saving;
    return saving;
  });
  const saveBeforeLeaving = useStableEvent(() => {
    if (!tabId || !viewLoaded || viewLeaving.current) return;
    viewLeaving.current = true;
    void saveConversationView(tabId, currentView()).catch(error => console.error("[conversation-view]", error));
  });
  useEffect(() => {
    const returned = () => { viewLeaving.current = false; };
    window.addEventListener("beforeunload", saveBeforeLeaving);
    window.addEventListener("pagehide", saveBeforeLeaving);
    window.addEventListener("pageshow", returned);
    return () => {
      window.removeEventListener("beforeunload", saveBeforeLeaving);
      window.removeEventListener("pagehide", saveBeforeLeaving);
      window.removeEventListener("pageshow", returned);
    };
  }, [saveBeforeLeaving]);
  /** 恢复会话草稿：把视图写回会话与附件状态，避免 effect 依赖整个 hook 返回值。 */
  const applyRestoredView = useStableEvent((view: ConversationView) => {
    session.setPrompt(view.prompt || "");
    if (!isTauriRuntime && view.previewTurn) restorePreviewTurn(view.previewTurn);
    attachments.setAttachment(view.attachment ?? undefined);
    attachments.setScreenshot(view.screenshot ?? undefined);
    attachments.setAttachmentAction(view.attachmentAction || "summarize");
    session.setConversation(current => ({ ...current, cwd: view.cwd || current.cwd, knowledgeScope: view.knowledgeScope ?? current.knowledgeScope }));
  });
  useEffect(() => {
    if (!tabId) return;
    let disposed = false;
    const loading = loadConversationView(tabId).then(view => {
      if (disposed) return;
      if (view) applyRestoredView(view);
      setViewLoaded(true);
    });
    viewReady.current = loading;
    void loading.catch(error => { if (!disposed) toast.error(toUserMessage(error, "会话草稿恢复失败，请重新打开会话。")); });
    return () => { disposed = true; };
  }, [tabId, toast, applyRestoredView]);
  useEffect(() => {
    if (!tabId || !viewLoaded) return;
    const timer = window.setTimeout(() => { void saveViewNow().catch(error => toast.error(toUserMessage(error, "会话草稿保存失败"))); }, 150);
    return () => window.clearTimeout(timer);
  }, [tabId, viewLoaded, session.prompt, session.message, session.replyStatus, attachments.attachment, attachments.screenshot, attachments.attachmentAction, session.conversation.cwd, session.conversation.knowledgeScope, saveViewNow, toast]);
  const handoffView = useStableEvent(async (returning = false) => {
    if (handoffPending || (!returning && !onDetach) || (returning && !onReturn)) return;
    setHandoffPending(true);
    try {
      await viewReady.current;
      await saveViewNow();
      if (returning) await onReturn?.(); else await onDetach?.();
    } catch (error) { toast.error(toUserMessage(error, "窗口切换失败，当前会话仍保留，请重试。")); }
    finally { setHandoffPending(false); }
  });
  useEffect(() => {
    if (!onReturn) return;
    const requested = () => { void handoffView(true); };
    window.addEventListener("conversation-request-return", requested);
    const subscription = isTauriRuntime
      ? listen<string>("conversation-close-requested", ({ payload }) => { if (payload === tabId) requested(); }) : undefined;
    return () => {
      window.removeEventListener("conversation-request-return", requested);
      if (subscription) void subscription.then(dispose => dispose());
    };
  }, [onReturn, tabId, handoffView]);

  async function togglePinned() {
    const next = !isPinned;
    setPinPending(true);
    try {
      if (isTauriRuntime) await getCurrentWindow().setAlwaysOnTop(next);
      setIsPinned(next);
    } catch (error) {
      toast.error(toUserMessage(error, "切换窗口置顶失败，请重试。"));
    } finally {
      setPinPending(false);
    }
  }

  useEffect(() => {
    if (!contextOpen || !isTauriRuntime) return;
    let activeProject = true;
    void runCommand("knowledge_list_documents").then(documents => {
      if (activeProject && Array.isArray(documents)) setKnowledgeProjects([...new Set(documents.map(document => document.scope).filter(Boolean))].sort());
    }).catch(() => { /* Manual project entry remains available. */ });
    return () => { activeProject = false; };
  }, [contextOpen]);

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
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime) return;
    const pending = listen<VoiceAssistantEvent>("voice-assistant-state", (event) => setVoiceEvent(event.payload));
    return () => { void pending.then((unlisten) => unlisten()); };
  }, []);
  // 错误提示短暂展示后自动消失；正常阶段由下一个状态事件自然替换。
  useEffect(() => {
    if (!voiceEvent?.message || voiceEvent.stage !== "idle") return;
    const timer = window.setTimeout(() => setVoiceEvent(null), 8000);
    return () => window.clearTimeout(timer);
  }, [voiceEvent]);
  const voicePill = useMemo(() => {
    if (!voiceEvent) return null;
    const { stage, transcript, reply, message: eventMessage } = voiceEvent;
    if (stage === "listening") return { stage, text: "在听…请说出你的指令" };
    if (stage === "thinking") return { stage, text: transcript ? `「${transcript}」思考中…` : "思考中…" };
    if (stage === "speaking") return { stage, text: reply ? `「${reply}」` : "播报中…" };
    if (eventMessage) return { stage: "error", text: eventMessage };
    return null;
  }, [voiceEvent]);

  // S07：输入活动以最近按键为准，保留草稿不会永久阻止提醒。
  useEffect(() => {
    if (!isTauriRuntime || !active) return;
    const report = () => reportSoulActivity(currentActivitySnapshot(isTypingRecently()));
    report();
    const timer = window.setInterval(report, ACTIVITY_HEARTBEAT_SECONDS * 1000);
    return () => window.clearInterval(timer);
  }, [active, isTypingRecently]);

  useEffect(() => {
    if (active && viewLoaded) {
      if (!document.activeElement?.closest('[role="tablist"]')) promptInputRef.current?.focus();
    }
    else { stopVoiceRecording(false); }
  }, [active, viewLoaded, stopVoiceRecording]);

  // Auto-scroll thread to bottom when new messages arrive
  useEffect(() => {
    if (session.agentApprovals.length || session.workspaceRequired || session.pendingAction) return;
    const el = threadScrollRef.current;
    if (el && followThreadRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [session.message, session.showReplySkeleton, session.currentPrompt, session.chatHistory.length, session.agentApprovals.length, session.workspaceRequired, session.pendingAction]);

  const topbarStatus = useMemo(() => {
    if (session.agentApprovals.length || session.pendingAction || session.agentPendingContract) return { label: "等待你确认", pulse: false };
    if (session.workspaceRequired) return { label: "等待选择文件夹", pulse: false };
    if (memoryActivity) return { label: memoryActivity, pulse: false };
    if (voice.isSpeaking) return { label: "朗读中", pulse: false };
    if (session.agentBusy) return { label: session.agentStatus || "正在处理…", pulse: true };
    if (session.isThinking) return { label: "思考中…", pulse: true };
    return { label: "在线", pulse: false };
  }, [session.isThinking, voice.isSpeaking, memoryActivity, session.agentBusy, session.agentStatus, session.agentApprovals.length, session.pendingAction, session.workspaceRequired, session.agentPendingContract]);

  useEffect(() => {
    if (!tabId || !onTabState || !viewLoaded || !session.taskStateLoaded) return;
    onTabState(tabId, {
      title: (session.chatHistory[0]?.prompt || session.currentPrompt || "新对话").slice(0, 24),
      busy: session.agentBusy || session.isThinking,
      waiting: Boolean(session.agentApprovals.length || session.pendingAction || session.workspaceRequired || session.agentPendingContract),
      status: session.replyStatus || "idle",
    });
  }, [tabId, onTabState, viewLoaded, session.taskStateLoaded, session.currentPrompt, session.chatHistory, session.agentBusy, session.isThinking, session.agentApprovals.length, session.pendingAction, session.workspaceRequired, session.agentPendingContract, session.replyStatus]);

  const resumeTask = useStableEvent((record: { requestId: string; conversationId: string }) => {
    if (isAgentBusy()) return;
    if (tabId && record.conversationId !== tabId) {
      if (onResumeConversation) void saveViewNow().then(() => onResumeConversation(record)).catch(error => toast.error(toUserMessage(error, "打开原会话失败")));
      return;
    }
    session.setVerificationOf(undefined); session.setResumeOf(record.requestId);
    replaceConversation({ ...session.conversation, id: record.conversationId, knowledgeScope: undefined, importHistory: false, turnIds: [] });
    session.setChatHistory([]);
    void session.sendPrompt(`请根据原会话和操作检查点先核对任务 ${record.requestId} 的实际结果，再安全继续未完成的步骤。已完成步骤不能重复执行；无法证明幂等的操作请先说明并等待新的明确指令。`, null, record.requestId);
  });
  useEffect(() => {
    if (!resumeRequest || !tabId) return;
    let disposed = false;
    void Promise.all([getAgentReady(), viewReady.current]).then(() => {
      if (disposed) return;
      if (isAgentBusy()) toast.info("原会话仍有任务正在执行，请等待结束后再续跑。");
      else resumeTask({ requestId: resumeRequest, conversationId: tabId });
      onResumeConsumed?.();
    }).catch(error => toast.error(toUserMessage(error, "恢复原会话失败")));
    return () => { disposed = true; };
  }, [resumeRequest, tabId, resumeTask, onResumeConsumed, toast, getAgentReady, isAgentBusy]);

  function newConversation() {
    if (onNewConversation) { onNewConversation(); return; }
    if (isAgentBusy() || session.isThinking) return;
    session.resetSession(session.conversation.cwd);
    attachments.setAttachment(undefined);
    attachments.setAttachmentAction("summarize");
    attachments.setScreenshot(undefined);
    setSelectedFavoriteId(null);
    setContextOpen(false);
    setFavoritesOpen(false);
    soul.setSoulReplyId(null);
    followThreadRef.current = true;
    setAwayFromBottom(false);
  }

  function handleWindowKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && selectedFavoriteId) return;
    if (event.key === "Escape" && (contextOpen || favoritesOpen)) {
      event.preventDefault();
      setContextOpen(false);
      setFavoritesOpen(false);
      return;
    }
    if (event.key === "Escape" && workspace.workspaceOpen) {
      event.preventDefault();
      void workspace.closeWorkspace();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (onReturn) void handoffView(true); else void runCommand("hide_bubble");
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      session.submitPrompt();
    }
  }

  async function copyResult() {
    await navigator.clipboard.writeText(session.message);
    setCopyFeedback(true);
    window.setTimeout(() => setCopyFeedback(false), 1200);
  }

  async function updateHtmlPreviewEnabled(enabled: boolean) {
    const settings = await runCommand(
      "update_html_preview_enabled",
      { enabled },
      { ...defaultAppSettings, htmlPreviewEnabled: enabled },
    );
    applyServer(parseAppSettings(settings));
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
      await runCommand("save_generated_text", { path, content: session.message, overwrite: false });
    } catch (error) {
      if (String(error).includes("目标文件已存在") && window.confirm("目标文件已存在，是否覆盖？")) {
        await runCommand("save_generated_text", { path, content: session.message, overwrite: true });
        return;
      }
      toast.error(toUserMessage(error, "保存失败，请重试。"));
    }
  }

  /** 回执里的路径相对项目根目录；拼上工作目录交给系统关联编辑器打开。 */
  function openReceiptFile(path: string) {
    const base = session.conversation.cwd;
    const absolute = /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("/");
    const target = base && !absolute ? `${base.replace(/[\\/]+$/, "")}/${path}` : path;
    openPath(target).catch((error) => toast.error(toUserMessage(error, "打开文件失败")));
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

  const selectedFavorite = selectedFavoriteId ? favorites.find((item) => item.id === selectedFavoriteId) : undefined;

  return (
    <div className={`conversation-workspace${workspace.workspaceOpen ? " conversation-workspace--open" : ""}`}
      style={{ "--workspace-panel-width": `${workspace.visiblePanelWidth}px` } as CSSProperties}>
    <main
      className={`bubble-shell bubble-shell--${theme}`}
      onKeyDown={handleWindowKeyDown}
      tabIndex={-1}
    >
      <BubbleTopbar
        workspaceOpen={workspace.workspaceOpen}
        surfacePending={surface.pending}
        onToggleWorkspace={() => void (workspace.workspaceOpen ? workspace.closeWorkspace() : workspace.openWorkspace())}
        onOpenWorkspace={(tab) => void workspace.openWorkspace(tab)}
        isThinking={session.isThinking}
        conversationTitle={conversationTitle}
        companionName={companionName}
        topbarStatus={topbarStatus}
        agentBusy={session.agentBusy}
        isPinned={isPinned}
        pinPending={pinPending}
        onTogglePinned={() => void togglePinned()}
        onDetach={onDetach}
        onReturn={onReturn}
        viewLoaded={viewLoaded}
        handoffPending={handoffPending}
        isListening={voice.isListening}
        onHandoff={(returning) => void handoffView(returning)}
        onNewConversation={newConversation}
        newConversationDisabled={!onNewConversation && (session.isThinking || session.agentBusy)}
      />

      <BubbleThread
        session={session}
        agent={session.agent}
        threadScrollRef={threadScrollRef}
        onScrollAway={(away) => { followThreadRef.current = !away; setAwayFromBottom(away); }}
        voicePill={voicePill}
        favorites={favorites}
        htmlPreviewEnabled={htmlPreviewEnabled}
        expandedHistoryIds={expandedHistoryIds}
        historySourceIds={historySourceIds}
        onToggleHistoryItem={toggleHistoryItem}
        onPreviewViewChange={setHistoryPreview}
        onToggleFavorite={toggleFavorite}
        onCollapseAll={collapseAllHistory}
        onOpenModelSettings={() => void workspace.openWorkspace("settings")}
        onSuggest={(suggestion) => { session.setPrompt(suggestion); promptInputRef.current?.focus(); }}
        aiConfigured={aiConfigured}
        companionName={companionName}
        onResume={resumeTask}
        onOpenFile={openReceiptFile}
        onChooseWorkspace={() => void chooseWorkspace()}
        onCancelWorkspace={() => void cancelWorkspace()}
        promptInputRef={promptInputRef}
        replyTools={{
          copyFeedback, isSpeaking: voice.isSpeaking,
          onCopy: () => void copyResult(),
          onSpeech: () => void voice.toggleSpeech(),
          onSave: () => void saveResult(),
          onUpdateHtmlPreview: (enabled) => void updateHtmlPreviewEnabled(enabled),
          onClearContext: () => void session.clearContext(),
          onOpenPanel: () => void workspace.openWorkspace(),
        }}
      />

      {selectedFavorite && (
        <HtmlFavoriteDialog
          favorite={selectedFavorite}
          returnFocusRef={favoritesButtonRef}
          onClose={() => setSelectedFavoriteId(null)}
          onToggleFavorite={() => void toggleFavorite(selectedFavorite.html, selectedFavorite.sourceChatId ?? undefined).catch((error) => toast.error(toUserMessage(error, "收藏失败，请重试。")))}
        />
      )}

      <BubbleComposer
        session={session}
        attachments={attachments}
        voice={voice}
        viewLoaded={viewLoaded}
        handoffPending={handoffPending}
        awayFromBottom={awayFromBottom}
        onJumpLatest={() => {
          const el = threadScrollRef.current;
          if (el) el.scrollTop = el.scrollHeight;
          followThreadRef.current = true;
          setAwayFromBottom(false);
        }}
        contextOpen={contextOpen}
        setContextOpen={setContextOpen}
        knowledgeProjects={knowledgeProjects}
        chooseWorkspace={() => void chooseWorkspace()}
        favorites={favorites}
        favoritesOpen={favoritesOpen}
        setFavoritesOpen={setFavoritesOpen}
        favoritesButtonRef={favoritesButtonRef}
        onSelectFavorite={setSelectedFavoriteId}
        onRemoveFavorite={(id) => { void removeFavorite(id).then(() => { if (selectedFavoriteId === id) setSelectedFavoriteId(null); }).catch(error => toast.error(toUserMessage(error, "删除失败，请重试。"))); }}
        soulMessage={soul.soulMessage}
        onRespondSoul={() => { soul.respondToSoul(); promptInputRef.current?.focus(); }}
        onDismissSoul={soul.dismissSoul}
        promptInputRef={promptInputRef}
      />

      {session.contextNotice && <p className="bubble-context-note" role="status">{session.contextNotice}</p>}
    </main>
    {workspace.workspaceVisited && <aside className="conversation-workspace__panel" hidden={!workspace.workspaceOpen} onKeyDown={(event) => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing && !(event.target as HTMLElement).closest("dialog, [role=dialog]")) {
        event.preventDefault(); void workspace.closeWorkspace();
      }
    }}>
      <WorkspaceDivider width={workspace.visiblePanelWidth} onChange={workspace.setPanelWidth} />
      <Suspense fallback={<p role="status">正在打开工作区…</p>}><PanelWindow activeTab={workspace.workspaceTab} onTabChange={workspace.setWorkspaceTab} onClose={() => void workspace.closeWorkspace()} /></Suspense>
    </aside>}
    </div>
  );
}
