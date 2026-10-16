import { useState } from "react";
import { runCommand } from "../app/appRuntime";
import type { TaskTerminal } from "./taskOutcomeModel";
import { toUserMessage } from "../../lib/errors";

export function TaskDiagnostics({ terminal }: { terminal: TaskTerminal | null }) {
  const [text, setText] = useState("");
  if (!terminal || terminal.status === "completed") return null;
  async function load() {
    try {
      const result = await runCommand<{ text: string; truncated: boolean }>("agent_get_diagnostics", { requestId: terminal!.requestId });
      setText((result.text || "没有额外诊断输出。") + (result.truncated ? "\n（输出已截断）" : ""));
    } catch (error) { setText(toUserMessage(error, "诊断读取失败，请重试")); }
  }
  return <details className="task-outcome"><summary>故障诊断</summary><p>已过滤常见凭据字段，仅保留最近任务的有限诊断输出。</p><button type="button" onClick={() => void load()}>读取诊断</button>{text && <pre>{text}</pre>}</details>;
}
