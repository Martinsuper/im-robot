import type { AgentEvent, AgentTaskSnapshot, MilestoneProgress, NoticeEntry, PendingContract, ReceiptObject, ReceiptRecord, ToolActivity, ToolApproval } from "./agentTypes";
import { applyMilestone, parseContract, parseNotice, parseReceipt } from "./agentTypes";
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
  /** 委托式任务（doc/design/18）：契约等待、里程碑时间线、黄旗与回执投影。 */
  pendingContract: PendingContract | null;
  milestones: MilestoneProgress[];
  notices: NoticeEntry[];
  receipt: ReceiptRecord | null;
};

export const initialAgentTaskState: AgentTaskState = {
  busy: false, status: "", tools: [], terminal: null, approvals: [], workspaceRequired: false,
  pendingContract: null, milestones: [], notices: [], receipt: null,
};

export type AgentTaskAction = { type: "update"; update: (state: AgentTaskState) => AgentTaskState } | { type: "begin"; requestId: string }
  | { type: "reset" } | { type: "restore"; snapshot: AgentTaskSnapshot } | { type: "event"; event: AgentEvent };

const MAX_NOTICES = 50;

function noticeAppended(state: AgentTaskState, event: AgentEvent): AgentTaskState {
  const notice = parseNotice(event.level, event.text);
  if (!notice) return state;
  return { ...state, notices: [...state.notices, notice].slice(-MAX_NOTICES) };
}

function currentMilestoneId(milestones: MilestoneProgress[]): string | undefined {
  return milestones.find((milestone) => milestone.status === "started")?.id;
}

export function agentTaskReducer(state: AgentTaskState, action: AgentTaskAction): AgentTaskState {
  if (action.type === "restore") {
    return action.snapshot.events.reduce<AgentTaskState>((current, event) => agentTaskReducer(current, { type: "event", event }),
      { ...initialAgentTaskState, requestId: action.snapshot.requestId, busy: true });
  }
  if (action.type === "reset") return initialAgentTaskState;
  if (action.type === "begin") return { ...initialAgentTaskState, requestId: action.requestId, busy: true };
  if (action.type === "update") return action.update(state);
  const event = action.event;
  if (event.requestId !== state.requestId) return state;
  // receipt 固定在终态事件之前到达（doc 18 §1）；即便乱序迟到也要先入状态供回执卡片使用。
  if (event.type === "receipt") {
    const receipt: ReceiptObject = parseReceipt(event.receipt);
    return { ...state, receipt: { status: event.status || "completed", summary: event.summary, receipt } };
  }
  if (state.terminal) return state;
  switch (event.type) {
    case "tool-start":
      return { ...state, status: `正在调用 ${event.tool}…`, tools: state.tools.some((tool) => tool.id === event.toolCallId) ? state.tools : [...state.tools,
        { id: event.toolCallId || "", name: event.tool || "工具", arguments: event.arguments || {}, status: "执行中", milestoneId: currentMilestoneId(state.milestones) }] };
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
    case "contract-proposed": {
      if (!event.contractId) return state;
      return { ...state, status: "等待你确认任务契约", pendingContract: { contractId: event.contractId, contract: parseContract(event.contract) } };
    }
    case "milestone": {
      const milestones = applyMilestone(state.milestones, event);
      const current = milestones.find((milestone) => milestone.status === "started");
      const status = current ? `正在执行：${current.title || current.id}` : state.status;
      return { ...state, milestones, status };
    }
    case "notice":
      return noticeAppended(state, event);
    case "usage":
      return state; // 预算遥测暂不在 UI 展示（doc 18 §1）。
    case "completed": case "failed": case "cancelled":
      return { ...state, busy: false, status: "", approvals: [], workspaceRequired: false, pendingContract: null,
        terminal: { requestId: event.requestId, status: event.type },
        tools: state.tools.map((tool) => tool.status === "执行中" ? { ...tool, status: "结果未知" } : tool) };
    default: return state;
  }
}
