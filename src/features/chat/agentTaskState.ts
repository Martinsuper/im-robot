import type { AgentEvent, AgentTaskSnapshot, ToolActivity, ToolApproval } from "./agentTypes";
import type { TaskTerminal } from "./taskOutcomeModel";

/** A UI projection of Rust task events; never an authority for tool execution. */
export type AgentTaskState = {
  requestId?: string;
  busy: boolean;
  status: string;
  tools: ToolActivity[];
  terminal: TaskTerminal | null;
  approvals: ToolApproval[];
  workspaceRequired: boolean;
};

export const initialAgentTaskState: AgentTaskState = {
  busy: false, status: "", tools: [], terminal: null, approvals: [], workspaceRequired: false,
};

export type AgentTaskAction = { type: "update"; update: (state: AgentTaskState) => AgentTaskState } | { type: "begin"; requestId: string }
  | { type: "reset" } | { type: "restore"; snapshot: AgentTaskSnapshot } | { type: "event"; event: AgentEvent };

export function agentTaskReducer(state: AgentTaskState, action: AgentTaskAction): AgentTaskState {
  if (action.type === "restore") {
    return action.snapshot.events.reduce<AgentTaskState>((current, event) => agentTaskReducer(current, { type: "event", event }),
      { ...initialAgentTaskState, requestId: action.snapshot.requestId, busy: true });
  }
  if (action.type === "reset") return initialAgentTaskState;
  if (action.type === "begin") return { ...initialAgentTaskState, requestId: action.requestId, busy: true };
  if (action.type === "update") return action.update(state);
  const event = action.event;
  if (event.requestId !== state.requestId || state.terminal) return state;
  switch (event.type) {
    case "tool-start":
      return { ...state, status: `正在调用 ${event.tool}…`, tools: state.tools.some((tool) => tool.id === event.toolCallId) ? state.tools : [...state.tools,
        { id: event.toolCallId || "", name: event.tool || "工具", arguments: event.arguments || {}, status: "执行中" }] };
    case "tool-end":
      return { ...state, status: "正在继续…", tools: state.tools.map((tool) => tool.id === event.toolCallId
        ? { ...tool, status: event.isError ? "失败" : "完成", output: event.output, verification: event.verification } : tool) };
    case "approval":
      if (!event.approvalId) return state;
      return { ...state, status: "等待你批准操作", approvals: state.approvals.some((item) => item.id === event.approvalId)
        ? state.approvals : [...state.approvals, { id: event.approvalId, tool: event.tool || "操作", arguments: event.arguments || {} }] };
    case "approval-resolved":
      return { ...state, status: event.allowed ? "已批准，正在继续…" : "已拒绝，正在继续…",
        approvals: state.approvals.filter((item) => item.id !== event.approvalId) };
    case "action-resolved":
      return { ...state, status: event.allowed ? "已确认，正在继续…" : "已取消，正在继续…" };
    case "workspace-resolved":
      return { ...state, workspaceRequired: false, status: event.cwd ? "目录已选择，正在继续…" : "已取消选择目录，正在继续…" };
    case "approval-expired":
      return { ...state, status: "操作确认已超时，该操作未获批准", approvals: state.approvals.filter((item) => item.id !== event.approvalId) };
    case "steering-accepted":
      return { ...state, approvals: [], workspaceRequired: false, status: "补充要求已加入；正在执行的操作可能已产生效果" };
    case "workspace-required":
      return { ...state, workspaceRequired: true, status: "请选择工作目录" };
    case "action-proposed":
      return event.draft ? { ...state, status: "等待你确认操作" } : state;
    case "completed": case "failed": case "cancelled":
      return { ...state, busy: false, status: "", approvals: [], workspaceRequired: false,
        terminal: { requestId: event.requestId, status: event.type },
        tools: state.tools.map((tool) => tool.status === "执行中" ? { ...tool, status: "结果未知" } : tool) };
    default: return state;
  }
}
