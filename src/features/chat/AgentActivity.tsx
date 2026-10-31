import { useEffect, useRef, useState } from "react";
import type { MilestoneProgress, NoticeEntry, ToolActivity, ToolApproval } from "./agentTypes";
import { milestoneStatusLabel } from "./taskOutcomeModel";
import { readTaskLog, type TaskLogResult } from "./agentWire";
import { toUserMessage } from "../../lib/errors";
import { useTranslation } from "../i18n/I18nProvider";
import "./agentTask.css";

const MILESTONE_ICONS: Record<string, string> = { started: "●", completed: "✓", failed: "✕", skipped: "↷" };

function ToolLedger({ tools, summary }: { tools: ToolActivity[]; summary: string }) {
  return <details className="agent-activity__details">
    <summary>{summary}</summary>
    {tools.map((tool) => <details key={tool.id} className="agent-activity__tool">
      <summary>{tool.name} · {tool.status}</summary>
      <pre>{JSON.stringify(tool.arguments, null, 2)}</pre>
      {tool.output && <pre>{tool.output}</pre>}
    </details>)}
  </details>;
}

type TaskLogState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "missing" }
  | { phase: "ready"; log: TaskLogResult }
  | { phase: "error"; message: string };

/** 任务日志只读面板 + 批注（doc 18 §9）：批注提交即作为 guidance steer 发送。 */
function TaskLogPanel({ requestId, onAnnotate }: { requestId: string; onAnnotate: (text: string) => void }) {
  const { t } = useTranslation();
  const [state, setState] = useState<TaskLogState>({ phase: "idle" });
  const [annotation, setAnnotation] = useState("");
  async function load() {
    setState({ phase: "loading" });
    try {
      const result = await readTaskLog(requestId);
      setState(result && result.exists ? { phase: "ready", log: result } : { phase: "missing" });
    } catch (cause) {
      setState({ phase: "error", message: toUserMessage(cause, t("chat.task.log.loadFailed", "任务日志读取失败，请重试。")) });
    }
  }
  function submit() {
    const text = annotation.trim();
    if (!text) return;
    onAnnotate(text);
    setAnnotation("");
  }
  return <details className="agent-activity__tasklog" onToggle={(event) => {
    if ((event.currentTarget as HTMLDetailsElement).open && state.phase === "idle") void load();
  }}>
    <summary>{t("chat.task.log.title", "任务日志")}</summary>
    {state.phase === "loading" && <p>{t("chat.task.log.loading", "正在读取任务日志…")}</p>}
    {state.phase === "missing" && <p>{t("chat.task.log.empty", "任务还没有日志。")}</p>}
    {state.phase === "error" && <p role="alert">{state.message}</p>}
    {state.phase === "ready" && <div>
      {state.log.truncated && <p>{t("chat.task.log.truncated", "日志过长，仅显示前 256KB。")}</p>}
      <pre>{state.log.content}</pre>
    </div>}
    <div className="agent-activity__tasklog-annotate">
      <textarea rows={2} maxLength={2000} value={annotation}
        aria-label={t("chat.task.log.annotationLabel", "任务批注")}
        placeholder={t("chat.task.log.annotationPlaceholder", "写下批注，将作为补充要求发送…")}
        onChange={(event) => setAnnotation(event.target.value)} />
      <p>{t("chat.task.log.annotationHint", "批注将在下一里程碑边界生效。")}</p>
      <button type="button" disabled={!annotation.trim()} onClick={submit}>{t("chat.task.log.annotationSend", "发送批注")}</button>
    </div>
  </details>;
}

export function AgentActivity({ tools, approvals, workspaceRequired, status, milestones = [], notices = [], requestId, onAnnotate, onApprove, onChooseWorkspace, onCancelWorkspace }: {
  tools: ToolActivity[]; approvals: ToolApproval[]; workspaceRequired: boolean; status: string;
  milestones?: MilestoneProgress[]; notices?: NoticeEntry[];
  requestId?: string; onAnnotate?: (text: string) => void;
  onApprove: (id: string, allowed: boolean) => void; onChooseWorkspace: () => void; onCancelWorkspace: () => void;
}) {
  const { t } = useTranslation();
  const approvalRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const button = approvalRef.current?.querySelector("button");
    button?.scrollIntoView?.({ block: "center" });
  }, [approvals, workspaceRequired]);
  if (!tools.length && !approvals.length && !workspaceRequired && !status && !milestones.length && !notices.length) return null;
  const delegated = milestones.length > 0;
  const preparationTools = delegated ? tools.filter((tool) => !tool.milestoneId) : tools;
  return <div className="agent-activity">
    {delegated && <ol className="agent-activity__timeline" aria-label={t("chat.task.milestone.aria", "执行里程碑")}>
      {milestones.map((milestone) => {
        const owned = tools.filter((tool) => tool.milestoneId === milestone.id);
        const current = milestone.status === "started";
        return <li key={milestone.id} className={`agent-activity__milestone agent-activity__milestone--${milestone.status}${current ? " agent-activity__milestone--current" : ""}`}
          aria-current={current ? "step" : undefined}>
          <span className="agent-activity__milestone-icon" aria-hidden="true">{MILESTONE_ICONS[milestone.status] || "●"}</span>
          <div className="agent-activity__milestone-body">
            <strong>{milestone.title || milestone.id} · {milestoneStatusLabel(milestone.status, t)}</strong>
            {milestone.note && <p>{milestone.note}</p>}
            {owned.length > 0 && <ToolLedger tools={owned}
              summary={t("chat.task.milestone.toolDetail", "操作明细 · {count} 项").replace("{count}", String(owned.length))} />}
          </div>
        </li>;
      })}
    </ol>}
    {delegated && preparationTools.length > 0 && <ToolLedger tools={preparationTools}
      summary={t("chat.task.milestone.preparation", "启动阶段操作 · {count} 项").replace("{count}", String(preparationTools.length))} />}
    {!delegated && tools.length > 0 && <ToolLedger tools={tools} summary={`执行详情 · ${tools.length} 项操作`} />}
    {notices.length > 0 && <ul className="agent-activity__notices">
      {notices.map((notice, index) => <li key={`${notice.level}-${index}`}
        className={`agent-activity__notice agent-activity__notice--${notice.level}`}>{notice.text}</li>)}
    </ul>}
    {delegated && requestId && onAnnotate && <TaskLogPanel key={requestId} requestId={requestId} onAnnotate={onAnnotate} />}
    {workspaceRequired && <section className="agent-activity__approval" aria-label="选择工作目录" ref={approvalRef}>
      <strong>先选择要操作的文件夹</strong>
      <p>选好后会继续当前任务。命令和文件修改仍需单独批准。</p>
      <button type="button" onClick={onCancelWorkspace}>取消此次操作</button>
      <button type="button" onClick={onChooseWorkspace}>选择文件夹并继续</button>
    </section>}
    {approvals.map((approval) => <section className="agent-activity__approval" aria-label="操作确认" key={approval.id} ref={approvalRef}>
      <strong>批准 {approval.tool} 操作？</strong>
      <pre>{JSON.stringify(approval.arguments, null, 2)}</pre>
      <p>命令可能访问工作目录外的文件，请检查实际参数。</p>
      <button type="button" onClick={() => onApprove(approval.id, false)}>拒绝</button>
      <button type="button" onClick={() => onApprove(approval.id, true)}>允许此次操作</button>
    </section>)}
    {status && <p className="agent-activity__status" role="status" aria-live="polite">{status}</p>}
  </div>;
}
