import { useEffect, useRef } from "react";
import type { ToolActivity, ToolApproval } from "./agentTypes";
import "./agentTask.css";

export function AgentActivity({ tools, approvals, workspaceRequired, status, onApprove, onChooseWorkspace, onCancelWorkspace }: {
  tools: ToolActivity[]; approvals: ToolApproval[]; workspaceRequired: boolean; status: string;
  onApprove: (id: string, allowed: boolean) => void; onChooseWorkspace: () => void; onCancelWorkspace: () => void;
}) {
  const approvalRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const button = approvalRef.current?.querySelector("button");
    button?.scrollIntoView?.({ block: "center" });
  }, [approvals, workspaceRequired]);
  if (!tools.length && !approvals.length && !workspaceRequired && !status) return null;
  return <div className="agent-activity">
    {tools.length > 0 && <details className="agent-activity__details">
      <summary>执行详情 · {tools.length} 项操作</summary>
      {tools.map((tool) => <details key={tool.id} className="agent-activity__tool">
        <summary>{tool.name} · {tool.status}</summary>
        <pre>{JSON.stringify(tool.arguments, null, 2)}</pre>
        {tool.output && <pre>{tool.output}</pre>}
      </details>)}
    </details>}
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
