import type { ToolActivity } from "./agentTypes";

export type TaskTerminal = { requestId: string; status: "completed" | "failed" | "cancelled" };

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
