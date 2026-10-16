import { useEffect, useState } from "react";
import { isTauriRuntime, runCommand } from "../app/appRuntime";
import { toUserMessage } from "../../lib/errors";
import "./taskHistory.css";
import { summarizeSteps } from "./taskOutcomeModel";

type TaskStep = { id: string; tool: string; status: string };
export type TaskRecord = {
  requestId: string; conversationId: string; status: string;
  startedAt: number; updatedAt: number; steps: TaskStep[];
};
const labels: Record<string, string> = {
  running: "执行中", waiting: "等待确认", completed: "已结束", failed: "失败",
  cancelled: "已取消", interrupted: "已中断", unknown: "结果未知",
};

export function TaskHistory({ busy, onInspect, onResume }: { busy: boolean; onInspect?: (record: TaskRecord) => void; onResume?: (record: TaskRecord) => void }) {
  const [records, setRecords] = useState<TaskRecord[]>([]);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!isTauriRuntime) return;
    let disposed = false;
    void runCommand<TaskRecord[]>("agent_list_tasks").then((items) => {
      if (!disposed) { setRecords(Array.isArray(items) ? items : []); setError(""); }
    }).catch((cause) => {
      if (!disposed) setError(toUserMessage(cause, "任务记录读取失败，请重试"));
    });
    return () => { disposed = true; };
  }, [busy, revision]);
  if (!records.length && !error) return null;
  const interrupted = records.some((record) => record.status === "interrupted");
  return <details className="task-history" open={interrupted || Boolean(error)}>
    <summary>任务记录{interrupted ? " · 有中断任务待核对" : ""}</summary>
    <p>重启后恢复执行记录，不会自动重新执行操作。工具返回成功也需要核对实际结果。</p>
    {error && <p role="alert">{error}</p>}
    <button type="button" onClick={() => setRevision((value) => value + 1)}>刷新任务记录</button>
    {records.slice(0, 10).map((record) => {
      const counts = summarizeSteps(record.steps.map((step) => step.status));
      return <section key={record.requestId} aria-label={`任务 ${record.requestId}`}>
      <strong>{labels[record.status] || record.status}</strong>
      <span> · {new Date(record.startedAt * 1000).toLocaleString()} · {record.requestId.slice(0, 8)}</span>
      {["interrupted", "failed", "cancelled"].includes(record.status) && <p>可能已有部分操作完成。请先检查实际结果，再决定如何继续。</p>}
      {onInspect && (["interrupted", "failed", "cancelled"].includes(record.status) || (record.status === "completed" && record.steps.length > 0)) && <button type="button" disabled={busy} onClick={() => onInspect(record)}>只读核对结果</button>}
      {onResume && ["interrupted", "failed", "cancelled"].includes(record.status) && <button type="button" disabled={busy} onClick={() => onResume(record)}>安全续跑</button>}
      {record.steps.length > 0 && <p>{counts.returned} 项工具返回成功 · {counts.failed} 项报告失败 · {counts.unknown} 项结果未知</p>}
      {record.steps.length ? <ol>{record.steps.map((step) => <li key={step.id}>
        {step.tool} · {step.status === "completed" ? "工具已返回" : labels[step.status] || step.status}
      </li>)}</ol> : <p>没有已记录的工具步骤；这不代表操作一定未发生。</p>}
    </section>;
    })}
  </details>;
}
