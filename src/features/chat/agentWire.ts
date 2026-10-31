import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../app/appRuntime";
import type { AgentPolicy } from "./agentTypes";

/**
 * 协议 v2（doc/design/18）新增的宿主命令尚未进入 generated/ipc 的命令白名单，
 * 在 Rust 侧落地并重新生成契约前先用原始 invoke；非 Tauri 环境回退到 fallback。
 * 契约收录后应迁移回 runCommand。
 */
export async function invokeV2<T>(command: string, args?: Record<string, unknown>, fallback?: T): Promise<T> {
  if (!isTauriRuntime) return fallback as T;
  return await invoke<T>(command, args);
}

// --- P2 增补契约（doc/design/18 §9）；宿主命令签名若有出入，只需调整本文件 ---

export type TaskLogResult = { exists: boolean; content: string; truncated?: boolean };
export type TaskStepEntry = { id?: string; tool?: string; status?: string };
export type TaskStepsResult = { steps?: TaskStepEntry[]; archivedCount?: number };
export type ScheduledTaskInput = {
  prompt: string;
  projectId?: string;
  workspace?: string;
  policy?: AgentPolicy;
  timeMinutes?: number;
  scheduledAt: string;
};
export type ScheduledTaskRecord = {
  id: string;
  prompt: string;
  projectId?: string;
  workspace?: string;
  scheduledAt?: unknown;
  status?: string;
};

/** 任务日志（<workspace>/.piko/task-<requestId>.md，上限 256KB 截断）。 */
export async function readTaskLog(requestId: string): Promise<TaskLogResult> {
  return invokeV2<TaskLogResult>("agent_read_task_log", { requestId }, { exists: false, content: "" });
}

/** 完整流水（含归档段 agent/steps-archive/<id>.json）。 */
export async function getTaskSteps(requestId: string, includeArchive: boolean): Promise<TaskStepsResult> {
  return invokeV2<TaskStepsResult>("agent_get_task_steps", { requestId, includeArchive }, { steps: [], archivedCount: 0 });
}

export async function listScheduledTasks(): Promise<ScheduledTaskRecord[]> {
  return invokeV2<ScheduledTaskRecord[]>("scheduled_task_list", undefined, []);
}

export async function createScheduledTask(task: ScheduledTaskInput): Promise<unknown> {
  // 宿主 ScheduledTaskInput.scheduledAt 为 unix 秒（doc 18 §9）；入参兼容 ISO 字符串。
  const scheduledAt = typeof task.scheduledAt === "number"
    ? task.scheduledAt
    : Math.floor(new Date(task.scheduledAt).getTime() / 1000);
  return invokeV2("scheduled_task_create", { input: { ...task, scheduledAt } });
}

export async function cancelScheduledTask(id: string): Promise<unknown> {
  return invokeV2("scheduled_task_cancel", { id });
}
