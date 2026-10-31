import { useState } from "react";
import type { ToolActivity } from "./agentTypes";
import { fileOperationTargets, milestoneStatusLabel, summarizeSteps, toolLabel, type TaskTerminal } from "./taskOutcomeModel";
import type { ReceiptRecord } from "./agentTypes";
import { TaskStepsPanel } from "./TaskStepsPanel";
import { useTranslation } from "../i18n/I18nProvider";
import "./taskOutcome.css";

const RECEIPT_STATUS_LABELS: Record<string, { key: string; fallback: string }> = {
  completed: { key: "chat.task.receipt.statusCompleted", fallback: "任务已完成" },
  suspended: { key: "chat.task.receipt.statusSuspended", fallback: "任务已挂起收尾" },
};

export function TaskOutcome({ terminal, tools, busy, receipt, onInspect, onOpenFile, onResumeWithFeedback }: {
  terminal: TaskTerminal | null; tools: ToolActivity[]; busy: boolean; receipt?: ReceiptRecord | null;
  onInspect: (requestId: string) => void;
  onOpenFile?: (path: string) => void;
  onResumeWithFeedback?: (requestId: string, feedback: string) => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState("");
  const [copyError, setCopyError] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  if (accepted) return null;
  if (!terminal) return null;
  if (!receipt && !tools.length) return null;
  const counts = summarizeSteps(tools.map((tool) => tool.status));
  const targets = fileOperationTargets(tools);
  const receiptTitle = receipt ? (RECEIPT_STATUS_LABELS[receipt.status] || RECEIPT_STATUS_LABELS.completed) : null;
  const title = receiptTitle ? t(receiptTitle.key, receiptTitle.fallback)
    : terminal.status === "cancelled" ? "执行已停止"
    : terminal.status === "failed" ? "执行未正常结束"
    : counts.failed || counts.unknown ? "执行已结束，有步骤需要核对" : "执行已结束";
  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(path); setCopyError("");
    } catch { setCopyError(t("chat.task.receipt.copyFailed", "复制失败，请手动选择路径复制。")); }
  }
  function submitFeedback() {
    const text = feedback.trim();
    if (!text || !onResumeWithFeedback) return;
    setRejectOpen(false);
    onResumeWithFeedback(terminal!.requestId, text);
  }
  const data = receipt?.receipt;
  return <section className="task-outcome" aria-label={receipt ? t("chat.task.receipt.ariaLabel", "任务回执") : "本轮执行结果"}>
    <strong>{title}</strong>
    {receipt?.summary && <p>{receipt.summary}</p>}
    {!receipt && <p>{counts.returned} 项工具返回成功 · {counts.failed} 项报告失败 · {counts.unknown} 项结果未知</p>}
    {!receipt && <p>{tools.filter((tool) => tool.verification?.state === "verified").length} 项操作通过读回验收，其余步骤保留原始证据供核对。</p>}
    {data && data.milestones.length > 0 && <div>
      <h4>{t("chat.task.receipt.milestones", "里程碑状态")}</h4>
      <ul className="task-outcome__milestones">{data.milestones.map((milestone) => <li key={milestone.id}>
        <strong>{milestone.title || milestone.id}</strong> · {milestoneStatusLabel(milestone.status, t)}
        {milestone.note && <span> — {milestone.note}</span>}
      </li>)}</ul>
    </div>}
    {data && data.filesChanged.length > 0 && <div>
      <h4>{t("chat.task.receipt.files", "改动文件")}</h4>
      <ul>{data.filesChanged.map((file) => <li key={file.path}>
        <code>{file.path}</code> <span>+{file.added} −{file.removed}</span>
        {onOpenFile && <button type="button" onClick={() => onOpenFile(file.path)} aria-label={`${t("chat.task.receipt.openFile", "在编辑器打开")} ${file.path}`}>{t("chat.task.receipt.openFile", "在编辑器打开")}</button>}
        <button type="button" onClick={() => void copyPath(file.path)} aria-label={`${t("chat.task.receipt.copyPath", "复制路径")} ${file.path}`}>{copied === file.path ? t("chat.task.receipt.copied", "已复制") : t("chat.task.receipt.copyPath", "复制路径")}</button>
      </li>)}</ul>
      {copyError && <p role="alert">{copyError}</p>}
    </div>}
    {data && data.verify.length > 0 && <div>
      <h4>{t("chat.task.receipt.verify", "验收结果")}</h4>
      <ul>{data.verify.map((item, index) => <li key={`${item.command}-${index}`}>
        <code>{item.command}</code> · <span>{item.ok ? t("chat.task.receipt.verifyPassed", "通过") : t("chat.task.receipt.verifyFailed", "未通过")}</span>
        {item.output && <pre>{item.output.slice(0, 400)}{item.output.length > 400 ? t("chat.task.receipt.outputTruncated", "\n…输出已截断") : ""}</pre>}
      </li>)}</ul>
    </div>}
    {data && (data.branch || data.commits.length > 0) && <p>
      {data.branch && <><span>{t("chat.task.receipt.branch", "分支")}</span> <code>{data.branch}</code>{" "}</>}
      {data.commits.length > 0 && <><span>{t("chat.task.receipt.commits", "提交")}</span> <code>{data.commits.join(", ")}</code></>}
    </p>}
    {data && data.openQuestions.length > 0 && <div>
      <h4>{t("chat.task.receipt.openQuestions", "遗留疑问")}</h4>
      <ul>{data.openQuestions.map((question) => <li key={question}>{question}</li>)}</ul>
    </div>}
    {data && data.notices.length > 0 && <div>
      <h4>{t("chat.task.receipt.notices", "黄旗记录")}</h4>
      <ul>{data.notices.map((notice, index) => <li key={`${notice.level}-${index}`} className={notice.level === "warn" ? "task-outcome__notice--warn" : ""}>{notice.text}</li>)}</ul>
    </div>}
    {!receipt && targets.length > 0 && <div>
      <h4>文件操作目标</h4>
      <p>以下路径来自成功返回的写入或修改调用，未独立检查文件内容。</p>
      <ul>{targets.map((path) => <li key={path}>
        <code>{path}</code>
        <button type="button" onClick={() => void copyPath(path)} aria-label={`复制路径 ${path}`}>{copied === path ? "已复制" : "复制路径"}</button>
      </li>)}</ul>
      {copyError && <p role="alert">{copyError}</p>}
    </div>}
    {tools.length > 0 && <details>
      <summary>{t("chat.task.receipt.toolEvidence", "查看工具证据")}</summary>
      {tools.map((tool) => <div className="task-outcome__evidence" key={tool.id}>
        <span>{toolLabel(tool.name)} · {tool.status === "完成" ? "工具已返回" : tool.status}</span>
        {tool.verification && <p>{tool.verification.state === "verified" ? "读回验收通过" : "尚未通过自动验收"}{tool.verification.reused ? " · 已跳过重复操作" : ""}</p>}
        {tool.output ? <pre>{tool.output.slice(0, 400)}{tool.output.length > 400 ? "\n…完整输出见执行详情" : ""}</pre> : <p>没有可展示的文本输出。</p>}
      </div>)}
    </details>}
    <TaskStepsPanel requestId={terminal.requestId} />
    <button type="button" disabled={busy} onClick={() => onInspect(terminal.requestId)}>{t("chat.task.receipt.inspect", "只读核对本轮结果")}</button>
    {onResumeWithFeedback && !rejectOpen && <button type="button" disabled={busy} className="is-secondary" onClick={() => setRejectOpen(true)}>{t("chat.task.receipt.reject", "打回重跑")}</button>}
    {rejectOpen && <div className="task-outcome__feedback">
      <textarea rows={3} maxLength={2000} value={feedback} autoFocus
        placeholder={t("chat.task.receipt.feedbackPlaceholder", "说明哪里不对或补充要求，提交后会以本任务为基础自动续跑。")}
        aria-label={t("chat.task.receipt.feedbackLabel", "打回反馈")}
        onChange={(event) => setFeedback(event.target.value)} />
      <div>
        <button type="button" disabled={!feedback.trim() || busy} onClick={submitFeedback}>{t("chat.task.receipt.sendFeedback", "发送反馈并续跑")}</button>
        <button type="button" className="is-secondary" onClick={() => { setRejectOpen(false); setFeedback(""); }}>{t("chat.task.receipt.cancelFeedback", "取消")}</button>
      </div>
    </div>}
    {receipt && <button type="button" className="is-secondary" onClick={() => setAccepted(true)}>{t("chat.task.receipt.accept", "接受并关闭")}</button>}
  </section>;
}
