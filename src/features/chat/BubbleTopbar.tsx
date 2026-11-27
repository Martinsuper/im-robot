import { getCurrentWindow } from "@tauri-apps/api/window";
import { CornerDownLeft, ExternalLink, PanelRight, Pin, Plus } from "lucide-react";
import type { PointerEvent } from "react";
import { isTauriRuntime } from "../app/appRuntime";
import { PetSprite } from "../app/appShared";
import { ChatModelMenu } from "./ChatModelMenu";
import { WorkspaceMenu } from "./WorkspaceMenu";
import type { PanelTab } from "../../types/appTypes";

type BubbleTopbarProps = {
  workspaceOpen: boolean;
  surfacePending: boolean;
  onToggleWorkspace: () => void;
  onOpenWorkspace: (tab: PanelTab) => void;
  isThinking: boolean;
  conversationTitle?: string;
  companionName: string;
  topbarStatus: { label: string; pulse: boolean };
  agentBusy: boolean;
  isPinned: boolean;
  pinPending: boolean;
  onTogglePinned: () => void;
  onDetach?: () => Promise<void>;
  onReturn?: () => Promise<void>;
  viewLoaded: boolean;
  handoffPending: boolean;
  isListening: boolean;
  onHandoff: (returning?: boolean) => void;
  onNewConversation: () => void;
  newConversationDisabled: boolean;
};

/** 气泡顶栏：身份、状态胶囊与窗口级操作按钮。 */
export function BubbleTopbar({
  workspaceOpen, surfacePending, onToggleWorkspace, onOpenWorkspace, isThinking, conversationTitle,
  companionName, topbarStatus, agentBusy, isPinned, pinPending, onTogglePinned, onDetach, onReturn,
  viewLoaded, handoffPending, isListening, onHandoff, onNewConversation, newConversationDisabled,
}: BubbleTopbarProps) {
  function startBubbleDrag(event: PointerEvent<HTMLElement>) {
    if (!isTauriRuntime || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, textarea, select, a, [data-no-drag]")) return;
    void getCurrentWindow().startDragging();
  }

  return (
    <header className="bubble-topbar" onPointerDown={startBubbleDrag}>
      <div className="bubble-topbar__navigation">
        <button type="button" className={`bubble-topbar__btn${workspaceOpen ? " bubble-topbar__btn--active" : ""}`} disabled={surfacePending} onClick={onToggleWorkspace} aria-label={workspaceOpen ? "收起主面板" : "打开主面板"} aria-expanded={workspaceOpen} title={workspaceOpen ? "收起工作区" : "展开工作区"}><PanelRight size={17} /></button>
        <WorkspaceMenu onSelect={onOpenWorkspace}><span className="bubble-topbar__left">
          <PetSprite mode={isThinking ? "thinking" : "idle"} compact />
          <span className="bubble-topbar__identity"><span className="bubble-topbar__name">{conversationTitle || companionName}</span><span className="bubble-topbar__subtitle">随时聊聊，一起做事</span></span>
        </span></WorkspaceMenu>
      </div>
      <div className="bubble-topbar__center">
        <span role="status" aria-live="polite" className={`bubble-topbar__status${topbarStatus.pulse ? " bubble-topbar__status--pulse" : ""}`}>
          <span className="bubble-topbar__dot" />
          {topbarStatus.label}
        </span>
      </div>
      <div className="bubble-topbar__right">
        <ChatModelMenu disabled={agentBusy || isThinking} />
        <button
          type="button"
          className={`bubble-topbar__btn${isPinned ? " bubble-topbar__btn--active" : ""}`}
          onClick={onTogglePinned}
          disabled={pinPending}
          aria-label="窗口置顶"
          aria-pressed={isPinned}
          title={isPinned ? "取消置顶" : "固定在其他窗口上方"}
        ><Pin size={17} /></button>
        {onDetach && <button type="button" className="bubble-topbar__btn" disabled={!viewLoaded || handoffPending || isListening} onClick={() => onHandoff()} aria-label="在独立窗口打开" title="在独立窗口打开"><ExternalLink size={16} /></button>}
        {onReturn && <button type="button" className="bubble-topbar__btn" disabled={!viewLoaded || handoffPending} onClick={() => onHandoff(true)} aria-label="返回主窗口" title="返回主窗口"><CornerDownLeft size={16} /></button>}
        <button type="button" className="bubble-topbar__btn" disabled={newConversationDisabled} onClick={onNewConversation} aria-label="新对话" title="新对话"><Plus size={17} /></button>
      </div>
    </header>
  );
}
