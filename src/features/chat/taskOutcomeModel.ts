import type { ToolActivity } from "./agentTypes";

export type TaskTerminal = { requestId: string; status: "completed" | "failed" | "cancelled" };

export type TaskStep = { id: string; tool: string; status: string };
export type TaskRecord = {
  requestId: string; conversationId: string; status: string;
  startedAt: number; updatedAt: number; steps: TaskStep[];
  /** P2（doc 18 §9）：契约等待中断的恢复需要原任务信息与契约痕迹；字段由宿主可选提供。 */
  prompt?: string; cwd?: string; contractPending?: boolean; contractId?: string;
};

/** 契约痕迹（doc 18 §9）：显式字段优先，回退到契约步骤标记。 */
export function hasContractTrace(record: TaskRecord): boolean {
  if (record.contractPending === true) return true;
  if (typeof record.contractId === "string" && record.contractId) return true;
  return record.steps.some((step) => step.tool === "contract" || step.tool === "contract-proposed");
}

/** agent_list_tasks 返回 JsonValue（含快照合并的 prompt/cwd 可选字段）；防御性收敛为 TaskRecord。 */
export function toTaskRecord(value: unknown): TaskRecord | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.requestId !== "string" || typeof item.status !== "string") return null;
  const step = (entry: unknown): TaskStep => {
    const source = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    return {
      id: typeof source.id === "string" ? source.id : "",
      tool: typeof source.tool === "string" ? source.tool : "",
      status: typeof source.status === "string" ? source.status : "unknown",
    };
  };
  return {
    requestId: item.requestId,
    conversationId: typeof item.conversationId === "string" ? item.conversationId : "",
    status: item.status,
    startedAt: typeof item.startedAt === "number" ? item.startedAt : 0,
    updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0,
    steps: Array.isArray(item.steps) ? item.steps.map(step) : [],
    prompt: typeof item.prompt === "string" ? item.prompt : undefined,
    cwd: typeof item.cwd === "string" ? item.cwd : undefined,
    contractPending: item.contractPending === true || undefined,
    contractId: typeof item.contractId === "string" ? item.contractId : undefined,
  };
}

export function toTaskRecords(items: unknown): TaskRecord[] {
  return (Array.isArray(items) ? items : []).flatMap((item) => {
    const record = toTaskRecord(item);
    return record ? [record] : [];
  });
}

/** sidecar 已死时续跑无意义：等待契约确认被打断的任务改为“重新发起”。 */
export function contractInterrupted(record: TaskRecord): boolean {
  return ["waiting", "interrupted"].includes(record.status) && hasContractTrace(record);
}

export function summarizeSteps(statuses: string[]) {
  const returned = statuses.filter((status) => status === "完成" || status === "completed").length;
  const failed = statuses.filter((status) => status === "失败" || status === "failed").length;
  return { returned, failed, unknown: statuses.length - returned - failed };
}

export function fileOperationTargets(tools: ToolActivity[]) {
  const targets = tools.filter((tool) => ["write", "edit"].includes(tool.name) && tool.status === "完成")
    .map((tool) => tool.arguments.path)
    .filter((path): path is string => typeof path === "string" && path.trim().length > 0);
  return [...new Set(targets)];
}

export function toolLabel(name: string) {
  const names: Record<string, string> = { read: "读取文件", write: "写入文件", edit: "修改文件", bash: "运行命令", powershell: "运行命令", piko_select_workspace: "选择目录" };
  const businessNames: Record<string, string> = {
    list_reminders: "查询提醒", create_reminder: "创建提醒", delete_reminder: "删除提醒",
    list_events: "查询日程", detect_conflicts: "检查日程冲突", create_event: "创建日程",
    create_event_batch: "批量创建日程", delete_event: "删除日程", delete_event_batch: "批量删除日程",
    list_memos: "查询备忘录", create_memo: "创建备忘录",
  };
  return names[name] || businessNames[name.split("__").pop() || ""] || name;
}

/** 完整流水里归档段是英文状态、实时段是中文状态，两种词表统一收敛（doc 18 §9）。 */
export function stepStatusLabel(status: string) {
  const labels: Record<string, string> = {
    completed: "工具已返回", 完成: "工具已返回",
    failed: "失败", 失败: "失败",
    unknown: "结果未知", 结果未知: "结果未知",
    running: "执行中", 执行中: "执行中",
    cancelled: "已取消", 已取消: "已取消",
  };
  return labels[status] || status;
}

/** doc 18 §1 的里程碑状态在时间线与回执里共用同一组文案。 */
export const MILESTONE_STATUS_LABELS: Record<string, { key: string; fallback: string }> = {
  started: { key: "chat.task.milestone.started", fallback: "执行中" },
  completed: { key: "chat.task.milestone.completed", fallback: "已完成" },
  failed: { key: "chat.task.milestone.failed", fallback: "失败" },
  skipped: { key: "chat.task.milestone.skipped", fallback: "已跳过" },
};

export function milestoneStatusLabel(status: string, translate: (key: string, fallback?: string) => string) {
  const entry = MILESTONE_STATUS_LABELS[status] || { key: "chat.task.milestone.started", fallback: "执行中" };
  return translate(entry.key, entry.fallback);
}
