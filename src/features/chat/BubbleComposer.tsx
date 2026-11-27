import { ArrowDown, ArrowUp, ListPlus, Mic, Paperclip, ScanLine, Square } from "lucide-react";
import type { FormEvent, RefObject } from "react";
import { isTauriRuntime } from "../app/appRuntime";
import { attachmentActionOptions, formatBytes } from "../app/appShared";
import { currentActivitySnapshot, reportSoulActivity, SOUL_CATEGORY_LABELS, type SoulProactiveMessage } from "../soul/proactiveBridge";
import { useTranslation } from "../i18n/I18nProvider";
import { ChatContextMenu } from "./ChatContextMenu";
import type { ChatAttachmentsApi } from "./useChatAttachments";
import type { ChatStreamApi } from "./useChatStream";
import type { VoiceControlApi } from "./useVoiceControl";
import type { HtmlFavorite } from "./htmlFavorites";

type BubbleComposerProps = {
  session: ChatStreamApi;
  attachments: ChatAttachmentsApi;
  voice: VoiceControlApi;
  viewLoaded: boolean;
  handoffPending: boolean;
  awayFromBottom: boolean;
  onJumpLatest: () => void;
  contextOpen: boolean;
  setContextOpen: (open: boolean) => void;
  knowledgeProjects: string[];
  chooseWorkspace: () => void;
  favorites: HtmlFavorite[];
  favoritesOpen: boolean;
  setFavoritesOpen: (open: boolean) => void;
  favoritesButtonRef: RefObject<HTMLButtonElement | null>;
  onSelectFavorite: (id: string) => void;
  onRemoveFavorite: (id: string) => void;
  soulMessage: SoulProactiveMessage | null;
  onRespondSoul: () => void;
  onDismissSoul: () => void;
  promptInputRef: RefObject<HTMLTextAreaElement | null>;
};

/** 输入区：附件/截图芯片、知识库与收藏菜单、主动消息、排队任务与发送表单。 */
export function BubbleComposer({
  session, attachments, voice, viewLoaded, handoffPending, awayFromBottom, onJumpLatest, contextOpen,
  setContextOpen, knowledgeProjects, chooseWorkspace, favorites, favoritesOpen, setFavoritesOpen,
  favoritesButtonRef, onSelectFavorite, onRemoveFavorite, soulMessage, onRespondSoul,
  onDismissSoul, promptInputRef,
}: BubbleComposerProps) {
  const { t } = useTranslation();
  const { attachment, attachmentAction, setAttachmentAction, screenshot, isDraggingFile, hasInputContext } = attachments;
  const { isListening, isTranscribingVoice, voiceAvailable, toggleVoiceInput } = voice;
  const agentBusy = session.agentBusy;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    session.submitPrompt();
  }

  return (
    <div className="bubble-input-zone">
      {awayFromBottom && <button type="button" className="bubble-jump-latest" onClick={onJumpLatest}><ArrowDown size={13} />回到最新消息</button>}
      {hasInputContext && (
        <div className="bubble-input-zone__chips">
          {attachment && (
            <div className="bubble-input-zone__chip">
              <span className="bubble-input-zone__chip-text">
                📄 {attachment.displayName} · {formatBytes(attachment.byteSize)}
              </span>
              <button type="button" className="bubble-input-zone__chip-remove" aria-label="移除附件" onClick={() => void attachments.clearAttachment()}>
                ✕
              </button>
            </div>
          )}
          {screenshot && (
            <div className="bubble-input-zone__chip">
              <img src={screenshot.dataUrl} alt="" className="bubble-input-zone__chip-thumb" />
              <span className="bubble-input-zone__chip-text">截图 {screenshot.width}×{screenshot.height}</span>
              <button type="button" className="bubble-input-zone__chip-remove" aria-label="移除截图" onClick={() => void attachments.clearScreenshot()}>
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
      {contextOpen && <label className="chat-workspace__directory">
        知识库项目
        <input list="piko-knowledge-projects" aria-label="知识库项目" placeholder="留空检索全部项目" maxLength={120}
          value={session.conversation.knowledgeScope || ""} disabled={agentBusy || session.conversation.turnIds.length > 0}
          onChange={event => session.setConversation(current => ({ ...current, knowledgeScope: event.target.value }))} />
        <datalist id="piko-knowledge-projects">{knowledgeProjects.map(project => <option key={project} value={project} />)}</datalist>
        <small>首轮发送后固定；切换项目请新建对话。通用资料始终可用。</small>
      </label>}
      <ChatContextMenu cwd={session.conversation.cwd} disabled={!isTauriRuntime || agentBusy}
        open={contextOpen} onToggle={() => setContextOpen(!contextOpen)} onChoose={() => void chooseWorkspace()}
        projectId={session.conversation.projectId} projectName={session.conversation.projectName}
        onSelectProject={(project) => session.setConversation((current) => ({ ...current, cwd: project.path, projectId: project.id, projectName: project.name }))}
        favoritesOpen={favoritesOpen} onToggleFavorites={() => setFavoritesOpen(!favoritesOpen)}
        favoritesButtonRef={favoritesButtonRef} favorites={favorites}
        onSelect={id => { onSelectFavorite(id); setFavoritesOpen(false); }}
        onRemove={id => onRemoveFavorite(id)} />
      {soulMessage && (
        <div className="bubble-soul-note" role="status" data-soul-id={soulMessage.id}>
          <div className="bubble-soul-note__body">
            <p>{soulMessage.text || SOUL_CATEGORY_LABELS[soulMessage.category]}</p>
            <div className="bubble-soul-note__actions">
              <button type="button" onClick={onRespondSoul}>
                回应
              </button>
              <button type="button" onClick={onDismissSoul}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
      {session.taskQueue.length > 0 && <div className="bubble-task-queue" aria-label={t("chat.task.queue.aria", "排队任务")}>
        <span className="bubble-queue-badge">{t("chat.task.queue.badge", "队列中 {count}").replace("{count}", String(session.taskQueue.length))}</span>
        {session.taskQueue.map((item) => <span key={item.id} className="bubble-task-queue__item">
          <span className="bubble-task-queue__text">{item.text}</span>
          <button type="button" aria-label={`${t("chat.task.queue.remove", "移除排队任务")}：${item.text}`}
            onClick={() => session.removeQueuedTask(item.id)}>✕</button>
        </span>)}
      </div>}
      <form className={`prompt-form${isDraggingFile ? " prompt-form--dragging" : ""}`} onSubmit={submit}>
        <div className="prompt-tools" aria-label="输入工具">
          <button type="button" onClick={() => void attachments.chooseAttachment()} disabled={!viewLoaded || handoffPending} aria-label="选择文件" title="选择文件">
            <Paperclip size={16} /><span>文件</span>
          </button>
          <button type="button" onClick={() => void attachments.beginCapture()} disabled={!viewLoaded || handoffPending} aria-label="截图提问" title="截图提问">
            <ScanLine size={16} /><span>截图</span>
          </button>
          <button
            type="button"
            className={isListening ? "is-active" : ""}
            disabled={isTranscribingVoice || !voiceAvailable || !viewLoaded || handoffPending}
            onClick={() => void toggleVoiceInput()}
            aria-label={isListening ? "停止语音输入" : isTranscribingVoice ? "正在转写语音" : "开始语音输入"}
            title={isListening ? "停止语音输入" : isTranscribingVoice ? "正在转写语音" : "语音输入"}
          >
            {isListening ? <Square size={14} /> : <Mic size={17} />}
          </button>
          {agentBusy && session.codingTask && <div className="bubble-steer-mode" role="group" aria-label={t("chat.task.steer.modeLabel", "插话方式")}>
            <button type="button" className={session.steerMode === "guidance" ? "is-active" : ""} aria-pressed={session.steerMode === "guidance"}
              title={t("chat.task.steer.guidanceHint", "在下一个里程碑边界注入，不收回自动授权")}
              onClick={() => session.setSteerMode("guidance")}>{t("chat.task.steer.guidance", "补充")}</button>
            <button type="button" className={session.steerMode === "redirect" ? "is-active" : ""} aria-pressed={session.steerMode === "redirect"}
              title={t("chat.task.steer.redirectHint", "立即注入并收回未决授权")}
              onClick={() => session.setSteerMode("redirect")}>{t("chat.task.steer.redirect", "转向")}</button>
          </div>}
          {agentBusy && <button type="button" className={session.queueNext ? "is-active" : ""} aria-pressed={session.queueNext}
            title={t("chat.task.queue.modeHint", "当前任务结束后自动发送为新的任务")}
            aria-label={t("chat.task.queue.mode", "排队为下一个任务")}
            onClick={() => session.setQueueNext((value) => !value)}><ListPlus size={15} /></button>}
          {session.guidanceQueue.length > 0 && <span className="bubble-queue-badge" role="status">{t("chat.task.steer.queueBadge", "排队中 {count} 条").replace("{count}", String(session.guidanceQueue.length))}</span>}
          {agentBusy && <button type="submit" aria-label={session.queueNext ? t("chat.task.queue.sendAria", "排队新任务") : "补充要求"}
            title={session.queueNext ? t("chat.task.queue.modeHint", "当前任务结束后自动发送为新的任务") : "补充当前任务要求"}
            disabled={!session.prompt.trim() || (!session.queueNext && session.sendingSteering)}><ArrowUp size={17} /></button>}
        </div>
        <textarea
          rows={2}
          disabled={!viewLoaded || handoffPending}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
              event.preventDefault();
              session.submitPrompt();
            }
          }}
          ref={promptInputRef}
          value={session.prompt}
          onChange={(event) => {
            session.markTyping();
            reportSoulActivity(currentActivitySnapshot(true));
            session.setPrompt(event.currentTarget.value);
          }}
          placeholder={agentBusy ? "补充要求，让 Piko 接着处理…" : attachment || screenshot ? "想怎么处理？补充一些要求…" : "发消息，或交给 Piko 一件事…"}
          aria-label="发送给 Piko 的问题"
        />
        {(session.isThinking || agentBusy) ? (
          <button type="button" className="prompt-form__stop" onClick={session.cancel} title="停止生成" aria-label="停止生成">
            <Square size={15} />
          </button>
        ) : (
          <button type="submit" aria-label="发送消息" disabled={!session.prompt.trim() && !attachment && !screenshot}>
            <ArrowUp size={19} />
          </button>
        )}
      </form>
    </div>
  );
}
