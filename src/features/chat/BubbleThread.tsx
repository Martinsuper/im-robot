import { useEffect, useRef, type RefObject } from "react";
import { useToast } from "../../components/feedback/toastStore";
import { toUserMessage } from "../../lib/errors";
import { AgentActivity } from "./AgentActivity";
import { ActionConfirmationCard } from "./ActionConfirmationCard";
import { CollapsibleReply, HistoryItem, InlineToolbar, ModelSetupCard, ReplyStatusCard, WelcomeState } from "./ChatPresentation";
import { ContractCard } from "./ContractCard";
import { HtmlPreviewFrame, extractHtmlPreviewSource, type HtmlPreviewView } from "./HtmlPreviewFrame";
import { PetSprite } from "../app/appShared";
import { TaskDiagnostics } from "./TaskDiagnostics";
import { TaskHistory } from "./TaskHistory";
import { TaskOutcome } from "./TaskOutcome";
import { findFavoriteId } from "./htmlFavorites";
import { POLICY_PRESETS } from "./agentTypes";
import { getBubbleCompanionMessage } from "./bubbleMessage";
import type { ChatStreamApi } from "./useChatStream";
import type { useAgentTask } from "./useAgentTask";
import type { HtmlFavorite } from "./htmlFavorites";

type AgentTaskApi = ReturnType<typeof useAgentTask>;

type ReplyTools = {
  copyFeedback: boolean;
  isSpeaking: boolean;
  onCopy: () => void;
  onSpeech: () => void;
  onSave: () => void;
  onUpdateHtmlPreview: (enabled: boolean) => void;
  onClearContext: () => void;
  onOpenPanel: () => void;
};

type BubbleThreadProps = {
  session: ChatStreamApi;
  agent: AgentTaskApi;
  threadScrollRef: RefObject<HTMLDivElement | null>;
  onScrollAway: (away: boolean) => void;
  voicePill: { stage: string; text: string } | null;
  favorites: HtmlFavorite[];
  htmlPreviewEnabled: boolean;
  expandedHistoryIds: Set<string>;
  historySourceIds: Set<string>;
  onToggleHistoryItem: (id: string) => void;
  onPreviewViewChange: (id: string, view: HtmlPreviewView) => void;
  onToggleFavorite: (html: string, sourceChatId?: string) => Promise<void>;
  onCollapseAll: () => void;
  onOpenModelSettings: () => void;
  onSuggest: (text: string) => void;
  aiConfigured: boolean;
  companionName: string;
  onResume: (record: { requestId: string; conversationId: string }) => void;
  onOpenFile: (path: string) => void;
  onChooseWorkspace: () => void;
  onCancelWorkspace: () => void;
  promptInputRef: RefObject<HTMLTextAreaElement | null>;
  replyTools: ReplyTools;
};

/** 对话线程：历史、当前轮次、任务卡片与回复工具栏。 */
export function BubbleThread({
  session, agent, threadScrollRef, onScrollAway, voicePill, favorites, htmlPreviewEnabled,
  expandedHistoryIds, historySourceIds, onToggleHistoryItem, onPreviewViewChange, onToggleFavorite,
  onCollapseAll, onOpenModelSettings, onSuggest, aiConfigured, companionName, onResume, onOpenFile,
  onChooseWorkspace, onCancelWorkspace, promptInputRef, replyTools,
}: BubbleThreadProps) {
  const toast = useToast();
  const businessCardRef = useRef<HTMLDivElement>(null);
  const contractCardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!session.pendingAction) return;
    const buttons = Array.from(businessCardRef.current?.querySelectorAll("button") || []);
    (buttons.find((button) => button.textContent?.includes("确认执行")) || buttons[0])?.scrollIntoView?.({ block: "center" });
  }, [session.pendingAction]);
  useEffect(() => {
    if (!agent.agentPendingContract) return;
    contractCardRef.current?.scrollIntoView?.({ block: "center" });
  }, [agent.agentPendingContract]);

  const hasCurrentTurn = Boolean(session.currentPrompt || session.message || session.pendingAction || session.showReplySkeleton || agent.agentTools.length || agent.workspaceRequired);
  const showWelcome = !hasCurrentTurn && session.chatHistory.length === 0 && !session.historyError;
  const htmlPreviewSource = htmlPreviewEnabled ? extractHtmlPreviewSource(session.message) : null;
  const currentFavoriteId = htmlPreviewSource ? findFavoriteId(favorites, htmlPreviewSource) : undefined;
  const skeletonLineCount = session.pendingPromptSummary.length > 80 ? 4 : session.pendingPromptSummary.length > 24 ? 3 : 2;
  const skeletonLines = Array.from({ length: skeletonLineCount }, (_, index) => {
    if (index === 0) return "bubble-skeleton__line--wide";
    if (index === skeletonLineCount - 1) return "bubble-skeleton__line--short";
    return "bubble-skeleton__line--medium";
  });
  const skeletonLabel = session.pendingPromptSummary.hasAttachment
    ? "正在分析附件并生成回复"
    : session.pendingPromptSummary.hasScreenshot
      ? "正在分析截图并生成回复"
      : "正在生成回复";

  return (
    <section className="bubble-thread" ref={threadScrollRef} aria-label="对话内容" onScroll={(event) => {
      const el = event.currentTarget;
      onScrollAway(el.scrollHeight - el.scrollTop - el.clientHeight > 64);
    }}>
      {session.historyError && <p role="alert">{session.historyError} <button type="button" onClick={session.refreshChatHistory}>重试加载历史</button></p>}
      {voicePill && (
        <section className={`voice-assistant-pill voice-assistant-pill--${voicePill.stage}`} role="status" aria-live="polite">
          <span className="voice-assistant-pill__dot" />
          <span>{voicePill.text}</span>
        </section>
      )}
      <TaskHistory busy={session.agentBusy} onInspect={(record) => session.inspectTask(record.requestId)} onResume={onResume} onRestart={session.restartTask} />
      {session.verificationOf && <section className="task-history" aria-label="只读核对模式">
        <strong>正在只读核对结果</strong>
        <p>后续提问继续核对，不执行命令或修改。需要继续处理时，请先结束核对，再明确提出操作要求。</p>
        <button type="button" disabled={session.agentBusy} onClick={() => session.setVerificationOf(undefined)}>结束核对</button>
      </section>}
      {session.resumeOf && <section className="task-history" aria-label="安全续跑模式"><strong>正在安全续跑</strong><p>文件修改按检查点和读回结果续接；Shell 和未经证明的业务写入不会自动重放。</p><button type="button" disabled={session.agentBusy} onClick={() => session.setResumeOf(undefined)}>结束续跑</button></section>}
      {showWelcome && !aiConfigured && (
        <ModelSetupCard onOpenSettings={onOpenModelSettings} />
      )}
      {showWelcome && <WelcomeState companionName={companionName} message={getBubbleCompanionMessage() || ""} onSuggest={onSuggest} />}

      {session.chatHistory.length > 0 && (
        <div className="bubble-thread__history">
          {session.chatHistory.map((entry) => {
            const entrySource = extractHtmlPreviewSource(entry.response);
            return (
              <HistoryItem
                key={entry.id}
                entry={entry}
                isExpanded={expandedHistoryIds.has(entry.id)}
                htmlPreviewEnabled={htmlPreviewEnabled}
                previewAsSource={historySourceIds.has(entry.id)}
                isFavorited={entrySource ? Boolean(findFavoriteId(favorites, entrySource)) : false}
                onToggle={() => onToggleHistoryItem(entry.id)}
                onPreviewViewChange={(view) => onPreviewViewChange(entry.id, view)}
                onToggleFavorite={entrySource ? () => void onToggleFavorite(entrySource, entry.id).catch((error) => toast.error(toUserMessage(error, "收藏失败，请重试。"))) : undefined}
              />
            );
          })}
          {expandedHistoryIds.size > 0 && (
            <button type="button" className="bubble-thread__collapse-all" onClick={onCollapseAll}>
              收起历史记录 · {expandedHistoryIds.size}
            </button>
          )}
        </div>
      )}

      {hasCurrentTurn && (
        <div className="bubble-thread__current">
          {session.currentPrompt && (
            <div className="bubble-thread__user-bubble">
              {session.currentPrompt}
            </div>
          )}

          {session.isThinkingLong && session.isThinking ? (
            <p className="bubble-thread__thinking-long" role="status">还在思考，稍等一下…</p>
          ) : null}
          {session.showReplySkeleton ? (
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
          ) : session.pendingAction ? (
            <div ref={businessCardRef}><ActionConfirmationCard
              draft={session.pendingAction}
              selectedChoiceIndexes={session.selectedChoiceIndexes}
              onChoiceToggle={(choiceIndex) =>
                session.setSelectedChoiceIndexes((current) =>
                  current.includes(choiceIndex) ? current.filter((value) => value !== choiceIndex) : [...current, choiceIndex],
                )
              }
              onConfirm={() => void session.confirmAction()}
              onReject={() => void session.rejectAction()}
            /></div>
          ) : htmlPreviewSource ? (
            <div className="bubble-thread__ai-card">
              <div className="bubble-thread__ai-sprite">
                <PetSprite mode="idle" compact />
              </div>
              <HtmlPreviewFrame
                sourceChatId={session.requestId ?? session.conversation.id}
                source={htmlPreviewSource}
                isFavorited={Boolean(currentFavoriteId)}
                onToggleFavorite={() => void onToggleFavorite(htmlPreviewSource, session.requestId ?? session.conversation.id).catch((error) => toast.error(toUserMessage(error, "收藏失败，请重试。")))}
              />
            </div>
          ) : session.message.trim() ? (
            <div className={`bubble-thread__ai-card${session.isReplyEntering ? " bubble-thread__ai-card--entering" : ""}`}>
              <div className="bubble-thread__ai-sprite">
                <PetSprite mode="idle" compact />
              </div>
              <div className="bubble-thread__ai-content">
                <CollapsibleReply markdown={session.message} />
              </div>
            </div>
          ) : null}

          {!session.isThinking && session.message.trim() && !session.pendingAction && (
            <InlineToolbar
              message={session.message}
              isSpeaking={replyTools.isSpeaking}
              copyFeedback={replyTools.copyFeedback}
              htmlPreviewEnabled={htmlPreviewEnabled}
              onCopy={replyTools.onCopy}
              onSpeech={replyTools.onSpeech}
              onSave={() => replyTools.onSave()}
              onUpdateHtmlPreview={replyTools.onUpdateHtmlPreview}
              onClearContext={replyTools.onClearContext}
              onOpenPanel={replyTools.onOpenPanel}
            />
          )}
          {agent.agentPendingContract && <div ref={contractCardRef}><ContractCard pending={agent.agentPendingContract} disabled={session.contractBusy}
            onConfirm={(contract, policy, gitMode) => void session.resolveContract(true, contract, policy, gitMode)}
            onReject={() => void session.resolveContract(false, agent.agentPendingContract!.contract, POLICY_PRESETS.standard, "branch")} /></div>}
          <TaskOutcome key={agent.taskTerminal?.requestId || "pending"} terminal={agent.taskTerminal} tools={agent.agentTools} busy={session.agentBusy} receipt={agent.agentReceipt}
            onInspect={session.inspectTask} onOpenFile={onOpenFile} onResumeWithFeedback={session.rejectReceipt} />
          <TaskDiagnostics key={`diagnostics-${agent.taskTerminal?.requestId || "pending"}`} terminal={agent.taskTerminal} />
          <AgentActivity tools={agent.agentTools} approvals={agent.agentApprovals} workspaceRequired={agent.workspaceRequired} status={agent.agentStatus}
            milestones={agent.agentMilestones} notices={agent.agentNotices}
            requestId={session.requestId ?? agent.taskTerminal?.requestId} onAnnotate={(text) => session.annotateTask(text)}
            onApprove={(id, allowed) => void session.approveTool(id, allowed)} onChooseWorkspace={onChooseWorkspace} onCancelWorkspace={onCancelWorkspace} />
          {(session.replyStatus === "failed" || session.replyStatus === "cancelled") ? (
            <ReplyStatusCard
              tone={session.replyStatus}
              message={session.replyError}
              onRetry={() => { session.setPrompt(session.currentPrompt); promptInputRef.current?.focus(); }}
              onOpenSettings={onOpenModelSettings}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}
