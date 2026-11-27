import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { isTauriRuntime } from "../app/appRuntime";
import type { PanelTab } from "../../types/appTypes";
import type { useConversationSurface } from "./useConversationSurface";

type ConversationSurface = ReturnType<typeof useConversationSurface>;

type WorkspaceInteractionOptions = {
  surface: ConversationSurface;
  active: boolean;
  activeTabRef: RefObject<boolean>;
  tabId?: string;
  initialWorkspaceOpen: boolean;
  navigationRequest?: { tab: PanelTab; id: number };
  onWorkspaceState?: (id: string, tab: PanelTab | null) => void;
  promptInputRef: RefObject<HTMLTextAreaElement | null>;
};

/**
 * 工作区交互维度：面板开关、宽度与当前页签、导航请求，以及原生窗口的 workspace-open 广播。
 * 面板开关只切换原生窗口尺寸，不重挂载会话，因此输入与流式状态都留在原位。
 */
export function useWorkspaceInteraction({
  surface, active, activeTabRef, tabId, initialWorkspaceOpen, navigationRequest, onWorkspaceState, promptInputRef,
}: WorkspaceInteractionOptions) {
  const [workspaceOpen, setWorkspaceOpen] = useState(initialWorkspaceOpen);
  const [workspaceVisited, setWorkspaceVisited] = useState(initialWorkspaceOpen);
  const [panelWidth, setPanelWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem("piko.workspace.width"));
      return saved >= 360 && saved <= 480 ? saved : 400;
    } catch { return 400; }
  });
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const visiblePanelWidth = Math.min(panelWidth, Math.max(360, viewportWidth - 480));
  useEffect(() => {
    try { localStorage.setItem("piko.workspace.width", String(panelWidth)); } catch { /* Optional preference. */ }
  }, [panelWidth]);
  const [workspaceTab, setWorkspaceTab] = useState<PanelTab>(() => {
    try {
      const saved = localStorage.getItem("piko.workspace.tab");
      return saved === "records" || saved === "settings" ? saved : "today";
    } catch { return "today"; }
  });
  const resizeWorkspace = surface.setWorkspaceOpen;
  /** Keep navigation local so no conversation or input state is remounted. */
  const openWorkspace = useCallback(async (tab?: PanelTab) => {
    // Navigation must not be dropped while the native window finishes resizing.
    if (tab) setWorkspaceTab(tab);
    if (await resizeWorkspace(true)) {
      setWorkspaceVisited(true);
      setWorkspaceOpen(true);
    }
  }, [resizeWorkspace]);
  const closeWorkspace = useCallback(async () => {
    if (await resizeWorkspace(false)) {
      setWorkspaceOpen(false);
      window.requestAnimationFrame(() => promptInputRef.current?.focus());
    }
  }, [resizeWorkspace, promptInputRef]);
  useEffect(() => {
    if (active) onWorkspaceState?.(tabId ?? "", workspaceOpen ? workspaceTab : null);
  }, [active, onWorkspaceState, tabId, workspaceOpen, workspaceTab]);
  const handledNavigation = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (navigationRequest && active && handledNavigation.current !== navigationRequest.id) {
      let cancelled = false;
      void Promise.resolve().then(() => {
        if (!cancelled) { handledNavigation.current = navigationRequest.id; void openWorkspace(navigationRequest.tab); }
      });
      return () => { cancelled = true; };
    }
  }, [navigationRequest, active, openWorkspace]);
  useEffect(() => {
    try { localStorage.setItem("piko.workspace.tab", workspaceTab); } catch { /* Optional preference. */ }
  }, [workspaceTab]);
  useEffect(() => {
    if (!isTauriRuntime) return;
    let disposed = false;
    const pending = listen<PanelTab | null>("workspace-open", ({ payload }) => {
      if (!activeTabRef.current) return;
      void openWorkspace(payload && ["today", "records", "settings"].includes(payload) ? payload : undefined);
    });
    void pending.then(() => { if (!disposed) void emit("workspace-ready"); });
    return () => { disposed = true; void pending.then((dispose) => dispose()); };
  }, [openWorkspace, activeTabRef]);
  return {
    workspaceOpen, workspaceVisited, workspaceTab, setWorkspaceTab,
    panelWidth, setPanelWidth, visiblePanelWidth,
    openWorkspace, closeWorkspace,
  };
}
