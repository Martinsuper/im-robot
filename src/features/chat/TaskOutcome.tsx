import { useState } from "react";
import type { ToolActivity } from "./agentTypes";
import { fileOperationTargets, summarizeSteps, toolLabel, type TaskTerminal } from "./taskOutcomeModel";
import "./taskOutcome.css";

export function TaskOutcome({ terminal, tools, busy, onInspect }: {
  terminal: TaskTerminal | null; tools: ToolActivity[]; busy: boolean;
  onInspect: (requestId: string) => void;
}) {
  const [copied, setCopied] = useState("");
  const [copyError, setCopyError] = useState("");
  if (!terminal || !tools.length) return null;
  const counts = summarizeSteps(tools.map((tool) => tool.status));
  const targets = fileOperationTargets(tools);
  const title = terminal.status === "cancelled" ? "执行已停止"
    : terminal.status === "failed" ? "执行未正常结束"
    : counts.failed || counts.unknown ? "执行已结束，有步骤需要核对" : "执行已结束";
  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(path); setCopyError("");
    } catch { setCopyError("复制失败，请手动选择路径复制。"); }
  }
  return <section className="task-outcome" aria-label="本轮执行结果">
    <strong>{title}</strong>
    <p>{counts.returned} 项工具返回成功 · {counts.failed} 项报告失败 · {counts.unknown} 项结果未知</p>
    <p>{tools.filter((tool) => tool.verification?.state === "verified").length} 项操作通过读回验收，其余步骤保留原始证据供核对。</p>
    {targets.length > 0 && <div>
      <h4>文件操作目标</h4>
      <p>以下路径来自成功返回的写入或修改调用，未独立检查文件内容。</p>
      <ul>{targets.map((path) => <li key={path}>
        <code>{path}</code>
        <button type="button" onClick={() => void copyPath(path)} aria-label={`复制路径 ${path}`}>{copied === path ? "已复制" : "复制路径"}</button>
      </li>)}</ul>
      {copyError && <p role="alert">{copyError}</p>}
    </div>}
    <details>
      <summary>查看工具证据</summary>
      {tools.map((tool) => <div className="task-outcome__evidence" key={tool.id}>
        <span>{toolLabel(tool.name)} · {tool.status === "完成" ? "工具已返回" : tool.status}</span>
        {tool.verification && <p>{tool.verification.state === "verified" ? "读回验收通过" : "尚未通过自动验收"}{tool.verification.reused ? " · 已跳过重复操作" : ""}</p>}
        {tool.output ? <pre>{tool.output.slice(0, 400)}{tool.output.length > 400 ? "\n…完整输出见执行详情" : ""}</pre> : <p>没有可展示的文本输出。</p>}
      </div>)}
    </details>
    <button type="button" disabled={busy} onClick={() => onInspect(terminal.requestId)}>只读核对本轮结果</button>
  </section>;
}
