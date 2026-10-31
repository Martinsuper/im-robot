import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

export function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

// A working directory is not a sandbox. Shell approval can be disabled by a trusted setting;
// even reads need approval when symlinks resolve outside the selected directory.
export async function needsApproval(name, args, cwd, autoApproveCommands = false) {
  if (autoApproveCommands === true && ["bash", "powershell"].includes(name)) return false;
  if (name !== "read") return true;
  try {
    return !isWithin(await realpath(cwd), await realpath(path.resolve(cwd, args.path)));
  } catch {
    return true;
  }
}

// 任务策略用：判断目标是否落在工作区内。与 needsApproval 的 read 分支不同，这里容忍
// 尚未创建的文件——回溯到最深的已存在祖先目录判断归属；解析失败一律视为工作区外（保守需审批）。
export async function resolveWithinWorkspace(cwd, target) {
  const absolute = path.resolve(cwd, target ?? "");
  try {
    return isWithin(await realpath(cwd), await realpath(absolute));
  } catch { /* 新文件或断链：走祖先回溯 */ }
  try {
    let cursor = absolute;
    const suffix = [];
    for (;;) {
      try {
        return isWithin(await realpath(cwd), path.join(await realpath(cursor), ...suffix));
      } catch (error) {
        if (error.code !== "ENOENT" || path.dirname(cursor) === cursor) return false;
        suffix.unshift(path.basename(cursor));
        cursor = path.dirname(cursor);
      }
    }
  } catch {
    return false;
  }
}

// 高危命令启发式（尽力而为）：shell=auto 下仍强制审批。shell 内容无法静态可靠分类，
// 这里只覆盖最常见的破坏性前缀、发布操作与系统路径写入；PRD 04 §4.3 已明示其局限。
const DANGEROUS_PATTERNS = [
  /(?:^|[;&|`(]\s*|\$\(\s*)(?:sudo|doas)\s+/i,
  /(?:^|[;&|(]\s*|`|&&|\|\|)\s*rm\s+(?:-\w+\s+)*-\w*(?:r|f)/i,
  /(?:^|[;&|(]\s*|`|&&|\|\|)\s*(?:mkfs(?:\.\w+)?|dd\s+if=|shutdown|reboot|halt|poweroff|crontab|launchctl)\b/i,
  /(?:^|[;&|(]\s*|`|&&|\|\|)\s*git\s+(?:-C\s+\S+\s+)?push\b/i,
  /(?:^|[;&|(]\s*|`|&&|\|\|)\s*(?:npm|pnpm|yarn|cargo|gem|dotnet)\s+publish\b/i,
  /(?:^|\s|=|"|')\/(?:etc|usr|bin|sbin|boot|sys|proc|dev|lib32|lib64|private\/etc|System|Windows)(?:\/|\s|$|["'])/i,
];

export function isDangerousCommand(command) {
  if (typeof command !== "string" || !command.trim()) return true;
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}

// 任务级策略裁决（doc 18 §5；仅 coding 任务使用，companion 一律走 needsApproval 现状路径）。
// outsideWorkspace 在 v2 恒为 confirm：write/edit 的 auto 只在判定工作区内时生效，工作区外
// 写入落回 needsApproval 的非 read 分支（恒需审批）。
export async function taskNeedsApproval(name, args, cwd, policy = {}, globalShellAuto = false) {
  if (["bash", "powershell"].includes(name)) {
    const auto = policy.shell === "auto" || globalShellAuto === true;
    return !auto || isDangerousCommand(args?.command);
  }
  if (["write", "edit"].includes(name) && policy.workspaceFiles === "auto") {
    return !(await resolveWithinWorkspace(cwd, args?.path));
  }
  return needsApproval(name, args, cwd);
}

export class ApprovalGate {
  pending = new Map();
  constructor(emit, timeoutMs = 5 * 60_000) { this.emit = emit; this.timeoutMs = timeoutMs; }
  request(tool, args, signal) {
    if (signal?.aborted) return Promise.reject(new Error("操作已取消"));
    const approvalId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        finish(false, "操作确认已超时，本次操作未获批准");
        this.emit({ type: "approval-expired", approvalId });
      }, this.timeoutMs);
      const abort = () => finish(false, "操作已取消");
      const finish = (allowed, reason = "用户未批准此操作") => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.pending.delete(approvalId);
        allowed ? resolve() : reject(new Error(reason));
      };
      this.pending.set(approvalId, finish);
      signal?.addEventListener("abort", abort, { once: true });
      this.emit({ type: "approval", approvalId, tool, arguments: args });
    });
  }
  reply(id, allowed) {
    const finish = this.pending.get(id);
    if (!finish) throw new Error("操作确认已过期");
    finish(allowed === true);
  }
  cancel() { for (const finish of [...this.pending.values()]) finish(false, "操作已取消"); }
}
