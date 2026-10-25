import { emitTo, listen } from "@tauri-apps/api/event";
import { openConversationWindow, closeConversationWindow, previewWindows, PREVIEW_WINDOWS_KEY, type WindowSnapshot } from "./conversationWindows";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CalendarDays, MessageCircle, NotebookPen, Settings2, Plus, X } from "lucide-react";
import { BubbleWindow, type ConversationTabState } from "./BubbleWindow";
import { CONVERSATION_STORAGE, loadConversation, type AgentTaskSnapshot, type AgentEvent } from "./agentTypes";
import { isTauriRuntime, runCommand } from "../app/appRuntime";
import { useToast } from "../../components/feedback/toastStore";

import type { PanelTab } from "../../types/appTypes";
import { useAppSettings } from "../panel/settingsStore";
import { deviceConversations } from "./deviceConversations";

const candidateId = new URLSearchParams(location.search).get("conversation");
const detachedId = candidateId && /^[a-zA-Z0-9-]{1,80}$/.test(candidateId) ? candidateId : null;
const TABS_STORAGE = "piko.conversation.tabs.v1";
const MAX_TABS = 12;
type Tab = { id: string; title: string };
type Tabs = { tabs: Tab[]; selected: string };

function initialTabs(): Tabs {
  if (detachedId) return { tabs: [{ id: detachedId, title: "新对话" }], selected: detachedId };
  try {
    const saved = JSON.parse(localStorage.getItem(TABS_STORAGE) || "null");
    if (Array.isArray(saved?.tabs)) {
      const ids = new Set<string>();
      const tabs: Tab[] = saved.tabs.filter((tab: Tab) => {
        if (typeof tab?.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(tab.id) || ids.has(tab.id)) return false;
        ids.add(tab.id);
        return true;
      }).slice(0, MAX_TABS).map((tab: Tab) => ({ id: tab.id, title: String(tab.title || "新对话").slice(0, 24) }));
      if (tabs.length) return { tabs, selected: tabs.some(tab => tab.id === saved.selected) ? saved.selected : tabs[0].id };
    }
  } catch { /* Storage is optional. */ }
  // Keep the last conversation when upgrading from the single-chat interface.
  const previous = loadConversation();
  const id = previous.id || crypto.randomUUID();
  try { localStorage.setItem(`${CONVERSATION_STORAGE}:${id}`, JSON.stringify({ ...previous, id, importHistory: false })); } catch { /* Optional. */ }
  return { tabs: [{ id, title: "新对话" }], selected: id };
}

export function ConversationTabs({ initialWorkspaceOpen = false }: { initialWorkspaceOpen?: boolean }) {
  const { settings } = useAppSettings();
  const [navigation, setNavigation] = useState<{ tab: PanelTab; id: number; conversationId: string }>();
  const [workspace, setWorkspace] = useState(initialTabs);
  const [states, setStates] = useState<Record<string, ConversationTabState>>({});
  const current = useRef(workspace);
  const [activePanel, setActivePanel] = useState<PanelTab | null>(initialWorkspaceOpen ? "today" : null);
  const reportWorkspace = useCallback((id: string, tab: PanelTab | null) => {
    if (id === current.current.selected) setActivePanel(tab);
  }, []);
  useLayoutEffect(() => { current.current = workspace; }, [workspace]);
  const [pendingResume, setPendingResume] = useState<{ requestId: string; conversationId: string }>();
  const consumeResume = useCallback(() => setPendingResume(undefined), []);
  const previousStates = useRef<Record<string, ConversationTabState>>({});
  const toast = useToast();
  const [nativeWindows, setNativeWindows] = useState<WindowSnapshot>(() => isTauriRuntime ? { revision: -1, windows: [] } : previewWindows());
  const [windowsLoaded, setWindowsLoaded] = useState(!isTauriRuntime || Boolean(detachedId));
  const windowsRef = useRef(nativeWindows);
  useLayoutEffect(() => { windowsRef.current = nativeWindows; }, [nativeWindows]);
  const applyWindows = useCallback((incoming: WindowSnapshot) => {
    if (detachedId) return;
    setNativeWindows(value => incoming.revision >= value.revision ? incoming : value);
    setWindowsLoaded(true);
    setWorkspace(value => {
      const missing = incoming.windows.filter(item => !value.tabs.some(tab => tab.id === item.conversationId));
      return missing.length ? { ...value, tabs: [...value.tabs, ...missing.map(item => ({ id: item.conversationId, title: item.title }))] } : value;
    });
  }, []);

  useEffect(() => {
    if (detachedId) return;
    try { localStorage.setItem(TABS_STORAGE, JSON.stringify(workspace)); } catch { /* Optional. */ }
  }, [workspace]);

  const updateTab = useCallback((id: string, state: ConversationTabState) => {
    const previous = previousStates.current[id];
    if (previous && previous.title === state.title && previous.busy === state.busy && previous.waiting === state.waiting && previous.status === state.status) return;
    previousStates.current[id] = state;
    setStates(value => ({ ...value, [id]: state }));
    setWorkspace(value => {
      const tab = value.tabs.find(tab => tab.id === id);
      return tab && tab.title !== state.title ? { ...value, tabs: value.tabs.map(tab => tab.id === id ? { ...tab, title: state.title } : tab) } : value;
    });
    if (id !== current.current.selected && previous?.busy) {
      const action = { label: "查看", onClick: () => setWorkspace(value => value.tabs.some(tab => tab.id === id) ? { ...value, selected: id } : value) };
      if (state.waiting && !previous.waiting) toast.info(`${state.title}：需要你确认或选择目录`, { action });
      else if (!state.busy) {
        if (state.status === "failed") toast.error(`${state.title}：任务失败，请查看详情`, { action });
        else toast.info(`${state.title}：${state.status === "cancelled" ? "任务已停止" : "任务已完成"}`, { action });
      }
    }
  }, [toast]);

  const requestResume = useCallback((record: { requestId: string; conversationId: string }) => {
    if (detachedId) {
      if (isTauriRuntime) void emitTo("bubble", "conversation-resume-requested", record).then(() => runCommand("show_bubble")).catch(error => toast.error(String(error)));
      else localStorage.setItem("piko.preview.resume-request", JSON.stringify({ ...record, nonce: crypto.randomUUID() }));
      return;
    }
    setPendingResume(record);
    setWorkspace(value => ({ tabs: value.tabs.some(tab => tab.id === record.conversationId) ? value.tabs : [...value.tabs, { id: record.conversationId, title: "继续任务" }], selected: record.conversationId }));
    if (windowsRef.current.windows.some(item => item.conversationId === record.conversationId)) void closeConversationWindow(record.conversationId).catch(error => toast.error(String(error)));
  }, [toast]);

  useEffect(() => {
    if (detachedId) return;
    if (!isTauriRuntime) {
      const changed = (event: StorageEvent) => {
        if (event.key === PREVIEW_WINDOWS_KEY) applyWindows(previewWindows());
        if (event.key === "piko.preview.resume-request" && event.newValue) requestResume(JSON.parse(event.newValue));
      };
      window.addEventListener("storage", changed);
      return () => window.removeEventListener("storage", changed);
    }
    let disposed = false;
    const requests = new Map<string, string>();
    const sequences = new Map<string, number>();
    const subscriptions = [
      listen<{ requestId: string; conversationId: string }>("conversation-resume-requested", ({ payload }) => requestResume(payload)),
      listen<WindowSnapshot>("conversation-windows-changed", ({ payload }) => applyWindows(payload)),
      listen<string>("conversation-returned", ({ payload }) => setWorkspace(value => ({ tabs: value.tabs.some(tab => tab.id === payload) ? value.tabs : [...value.tabs, { id: payload, title: "新对话" }], selected: payload }))),
      listen<AgentEvent>("agent-event", ({ payload: event }) => {
        if (event.conversationId) requests.set(event.requestId, event.conversationId);
        const id = requests.get(event.requestId);
        if (id?.startsWith("passport-") && event.conversationId) {
          setWorkspace(value => value.tabs.some(tab => tab.id === id) ? value : { ...value, tabs: [...value.tabs, { id, title: (event.prompt || "设备对话").slice(0, 24) }] });
        }
        if (!id || !windowsRef.current.windows.some(item => item.conversationId === id)) return;
        if (event.eventSequence !== undefined && event.eventSequence <= (sequences.get(event.requestId) ?? 0)) return;
        sequences.set(event.requestId, event.eventSequence ?? 0);
        const previous = previousStates.current[id];
        const terminal = ["completed", "failed", "cancelled"].includes(event.type);
        const waiting = ["approval", "action-proposed", "workspace-required"].includes(event.type) ? true
          : ["approval-resolved", "action-resolved", "workspace-resolved", "steering-accepted"].includes(event.type) || terminal ? false : previous?.waiting || false;
        updateTab(id, { title: (event.prompt || previous?.title || "进行中的任务").slice(0, 24), busy: !terminal, waiting, status: terminal ? event.type === "completed" ? "done" : event.type : "idle" });
      }),
    ];
    void Promise.all(subscriptions).then(async () => {
      const [windows, snapshots] = await Promise.all([
        runCommand("conversation_list_windows", undefined, { revision: 0, windows: [] }),
        runCommand("agent_get_task_snapshots", undefined, []) as unknown as Promise<AgentTaskSnapshot[]>,
      ]);
      if (disposed) return;
      applyWindows(windows);
      const [records, history] = await Promise.all([
        runCommand("agent_list_tasks"),
        runCommand("list_chat_history"),
      ]);
      if (disposed) return;
      const devices = deviceConversations(records, history);
      setWorkspace(value => {
        const missing = devices.filter(device => !value.tabs.some(tab => tab.id === device.id));
        return missing.length ? { ...value, tabs: [...value.tabs, ...missing] } : value;
      });
      for (const snapshot of snapshots) {
        requests.set(snapshot.requestId, snapshot.conversationId);
        if (snapshot.eventSequence < (sequences.get(snapshot.requestId) ?? 0)) continue;
        sequences.set(snapshot.requestId, snapshot.eventSequence);
        const terminal = snapshot.events.find(event => ["completed", "failed", "cancelled"].includes(event.type));
        if (!terminal) setWorkspace(value => value.tabs.some(tab => tab.id === snapshot.conversationId) ? value : { ...value, tabs: [...value.tabs, { id: snapshot.conversationId, title: snapshot.prompt.slice(0, 24) }] });
        if (windows.windows.some(item => item.conversationId === snapshot.conversationId)) updateTab(snapshot.conversationId, {
          title: snapshot.prompt.slice(0, 24) || "新对话", busy: !terminal,
          waiting: snapshot.events.some(event => ["approval", "action-proposed", "workspace-required"].includes(event.type)),
          status: terminal?.type === "completed" ? "done" : terminal?.type || "idle",
        });
      }
    }).catch(() => { if (!disposed) toast.error("恢复会话窗口失败，请重新打开聊天窗口。"); });
    return () => { disposed = true; for (const subscription of subscriptions) void subscription.then(dispose => dispose()); };
  }, [applyWindows, updateTab, requestResume, toast]);

  const returnToMain = useCallback(async () => { if (detachedId) await closeConversationWindow(detachedId); }, []);
  async function detach(id: string) {
    const title = current.current.tabs.find(tab => tab.id === id)?.title || "新对话";
    const windows = await openConversationWindow(id, title);
    applyWindows(windows);
  }

  const newTab = useCallback(() => {
    if (detachedId) {
      void openConversationWindow(crypto.randomUUID(), "新对话").catch(error => toast.error(String(error)));
      return;
    }
    if (current.current.tabs.length >= MAX_TABS) { toast.info("最多打开 12 个会话，请先关闭不用的会话。"); return; }
    const id = crypto.randomUUID();
    setWorkspace(value => ({ tabs: [...value.tabs, { id, title: "新对话" }], selected: id }));
  }, [toast]);

  function closeTab(id: string) {
    if (detachedId) { window.dispatchEvent(new Event("conversation-request-return")); return; }
    if (nativeWindows.windows.some(item => item.conversationId === id)) { toast.info("请先将独立窗口中的会话收回主窗口。"); return; }
    if (states[id]?.busy) { toast.info("请先停止此会话的任务，再关闭标签页。"); return; }
    const remaining = current.current.tabs.filter(tab => tab.id !== id);
    if (!remaining.length) {
      const nextId = crypto.randomUUID();
      setWorkspace({ tabs: [{ id: nextId, title: "新对话" }], selected: nextId });
    } else {
      const index = current.current.tabs.findIndex(tab => tab.id === id);
      setWorkspace(value => ({ tabs: remaining, selected: value.selected === id ? remaining[Math.min(index, remaining.length - 1)].id : value.selected }));
    }
    try { localStorage.removeItem(`${CONVERSATION_STORAGE}:${id}`); } catch { /* Optional. */ }
    if (isTauriRuntime) {
      void runCommand("clear_text_attachment", { contextId: id }).catch(() => {});
      void runCommand("conversation_forget_view", { conversationId: id }).catch(error => toast.error(String(error)));
    }
    delete previousStates.current[id];
  }

  const running = Object.values(states).filter(state => state.busy).length;
  return <div className={`conversation-tabs conversation-tabs--${settings.theme}${detachedId ? " conversation-tabs--detached" : " conversation-tabs--studio"}`}>
    <div className="conversation-tabs__bar">
      {!detachedId && <>
        <div className="studio-brand"><img src="/pets/piko-app-icon.png" alt="" /><div><strong>{settings.companionName}</strong><span>随时聊聊，一起做事</span></div></div>
        <nav className="studio-navigation" aria-label="主导航">
          <button type="button" className="studio-navigation__new" title="新对话" onClick={newTab}><MessageCircle size={20} />新对话</button>
          {([{ tab: "today", label: "今天", icon: CalendarDays }, { tab: "records", label: "记录", icon: NotebookPen }, { tab: "settings", label: "设置", icon: Settings2 }] as const).map(({ tab, label, icon: Icon }) => <button key={tab} type="button" title={label} className={activePanel === tab ? "is-active" : ""} aria-current={activePanel === tab ? "page" : undefined} onClick={() => setNavigation({ tab, id: Date.now(), conversationId: workspace.selected })}><Icon size={20} />{label}</button>)}
        </nav>
        <p className="studio-recent-label">最近对话</p>
      </>}

      <div className="conversation-tabs__list" role="tablist" aria-label="对话标签页" aria-orientation={detachedId ? "horizontal" : "vertical"} onKeyDown={event => {
        const index = workspace.tabs.findIndex(tab => tab.id === workspace.selected);
        const next = (event.key === "ArrowRight" || event.key === "ArrowDown") ? (index + 1) % workspace.tabs.length
          : (event.key === "ArrowLeft" || event.key === "ArrowUp") ? (index + workspace.tabs.length - 1) % workspace.tabs.length
          : event.key === "Home" ? 0 : event.key === "End" ? workspace.tabs.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault();
        const id = workspace.tabs[next].id;
        setWorkspace(value => ({ ...value, selected: id }));
        document.getElementById(`tab-${id}`)?.focus();
      }}>
        {workspace.tabs.map(tab => {
          const state = states[tab.id];
          const status = state?.waiting ? "等待确认" : state?.busy ? "执行中" : state?.status === "failed" ? "失败" : state?.status === "done" ? "已完成" : "";
          return <div className="conversation-tabs__item" key={tab.id}>
            <button id={`tab-${tab.id}`} role="tab" aria-selected={workspace.selected === tab.id} aria-controls={`surface-${tab.id}`} tabIndex={workspace.selected === tab.id ? 0 : -1}
              onClick={() => setWorkspace(value => ({ ...value, selected: tab.id }))} title={tab.title}>
              <span className="conversation-tabs__title">{tab.title}</span>
              {status && <span className={`conversation-tabs__status${state?.busy ? " is-busy" : ""}`}>{status}</span>}
            </button>
            <button className="conversation-tabs__close" aria-label={`关闭会话：${tab.title}`} disabled={!detachedId && (state?.busy || nativeWindows.windows.some(item => item.conversationId === tab.id))} onClick={() => closeTab(tab.id)}><X size={12} /></button>
          </div>;
        })}
      </div>
      <button className="conversation-tabs__new" aria-label="新建会话标签页" title="新建会话" onClick={newTab}><Plus size={16} /></button>
      {running > 0 && <span className="conversation-tabs__count" aria-live="polite">{running}/2</span>}
    </div>
    {!windowsLoaded && <p role="status">正在恢复会话窗口…</p>}
    {windowsLoaded && workspace.tabs.map(tab => <div key={tab.id} id={`surface-${tab.id}`} role="tabpanel" aria-labelledby={`tab-${tab.id}`} className="conversation-tabs__surface" hidden={workspace.selected !== tab.id}>
      {!detachedId && nativeWindows.windows.some(item => item.conversationId === tab.id) ? <div className="conversation-tabs__detached">
        <p>此会话已在独立窗口打开，后台任务会继续执行。</p>
        <button type="button" onClick={() => void detach(tab.id).catch(error => toast.error(String(error)))}>显示独立窗口</button>
        <button type="button" onClick={() => void closeConversationWindow(tab.id).catch(error => toast.error(String(error)))}>收回主窗口</button>
      </div> : <BubbleWindow onWorkspaceState={reportWorkspace} conversationTitle={tab.title} navigationRequest={navigation?.conversationId === tab.id ? navigation : undefined} tabId={tab.id} active={workspace.selected === tab.id} initialWorkspaceOpen={initialWorkspaceOpen && tab.id === workspace.tabs[0].id} onNewConversation={newTab} onTabState={updateTab} onDetach={detachedId ? undefined : () => detach(tab.id)} onReturn={detachedId ? returnToMain : undefined} onResumeConversation={requestResume} resumeRequest={pendingResume?.conversationId === tab.id ? pendingResume.requestId : undefined} onResumeConsumed={consumeResume} />}
    </div>)}
  </div>;
}
