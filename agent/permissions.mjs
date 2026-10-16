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
