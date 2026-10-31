import { describe, expect, it } from "vitest";
import { agentTaskReducer, initialAgentTaskState } from "./agentTaskState";
import type { AgentEvent } from "./agentTypes";

const begin = () => agentTaskReducer(initialAgentTaskState, { type: "begin", requestId: "current" });
const event = (state: ReturnType<typeof begin>, value: Omit<AgentEvent, "requestId"> & { requestId?: string }) =>
  agentTaskReducer(state, { type: "event", event: { requestId: "current", ...value } });

describe("task UI projection", () => {
  it("ignores stale tasks and late events after a terminal state", () => {
    const state = begin();
    expect(event(state, { type: "failed", requestId: "old" })).toBe(state);
    const done = event(state, { type: "completed" });
    expect(event(done, { type: "approval", approvalId: "late" })).toBe(done);
    expect(event(done, { type: "failed" })).toBe(done);
  });

  it.each(["completed", "failed", "cancelled"] as const)("clears pending UI atomically on %s", (type) => {
    let state = event(begin(), { type: "tool-start", toolCallId: "tool", tool: "write" });
    state = event(state, { type: "approval", approvalId: "approve", tool: "write" });
    state = event(state, { type: "workspace-required" });
    const done = event(state, { type });
    expect(done).toMatchObject({ busy: false, status: "", approvals: [], workspaceRequired: false,
      terminal: { requestId: "current", status: type } });
    expect(done.tools[0].status).toBe("结果未知");
  });

  it("deduplicates tool and approval events and preserves completed tool results", () => {
    let state = begin();
    for (let i = 0; i < 2; i++) {
      state = event(state, { type: "tool-start", toolCallId: "tool", tool: "read" });
      state = event(state, { type: "approval", approvalId: "approve" });
    }
    expect(state.tools).toHaveLength(1);
    expect(state.approvals).toHaveLength(1);
    state = event(state, { type: "tool-end", toolCallId: "tool", output: "verified" });
    state = event(state, { type: "completed" });
    expect(state.tools[0]).toMatchObject({ status: "完成", output: "verified" });
  });

  it("revokes pending UI on steering and starts a clean next task", () => {
    let state = event(begin(), { type: "approval", approvalId: "approve" });
    state = event(state, { type: "workspace-required" });
    state = event(state, { type: "steering-accepted" });
    expect(state).toMatchObject({ approvals: [], workspaceRequired: false, busy: true });
    const next = agentTaskReducer(state, { type: "begin", requestId: "next" });
    expect(next).toEqual({ ...initialAgentTaskState, requestId: "next", busy: true });
  });

  it("projects the delegated task contract and clears it once the user decides", () => {
    const state = event(begin(), { type: "contract-proposed", contractId: "c1", contract: { goal: "交付功能", milestones: [{ id: "m1", title: "实现", acceptance: "测试通过" }], verifyCommand: "npm test", timeMinutes: 30, risks: ["改动面大"] } });
    expect(state.status).toBe("等待你确认任务契约");
    expect(state.pendingContract).toMatchObject({ contractId: "c1", contract: { goal: "交付功能", verifyCommand: "npm test", timeMinutes: 30, risks: ["改动面大"] } });
    expect(state.pendingContract?.contract.milestones[0]).toEqual({ id: "m1", title: "实现", acceptance: "测试通过" });
    const done = event(state, { type: "cancelled" });
    expect(done.pendingContract).toBeNull();
  });

  it("folds milestone events into a timeline and attributes tools to the running milestone", () => {
    let state = event(begin(), { type: "milestone", milestoneId: "m1", status: "started", title: "准备" });
    state = event(state, { type: "tool-start", toolCallId: "t1", tool: "read" });
    state = event(state, { type: "milestone", milestoneId: "m1", status: "completed", note: "验收通过" });
    state = event(state, { type: "milestone", milestoneId: "m2", status: "started", title: "实现" });
    state = event(state, { type: "milestone", milestoneId: "m2", status: "started" });
    expect(state.milestones).toEqual([
      { id: "m1", status: "completed", title: "准备", note: "验收通过" },
      { id: "m2", status: "started", title: "实现", note: undefined },
    ]);
    expect(state.status).toBe("正在执行：实现");
    expect(state.tools[0].milestoneId).toBe("m1");
  });

  it("keeps notices with the latest last and drops empty ones", () => {
    let state = event(begin(), { type: "notice", level: "warn", text: "安装了依赖" });
    state = event(state, { type: "notice", level: "info", text: "  " });
    state = event(state, { type: "notice", level: "info", text: "新增了计划外文件" });
    expect(state.notices).toEqual([{ level: "warn", text: "安装了依赖" }, { level: "info", text: "新增了计划外文件" }]);
  });

  it("records the receipt before the terminal event and keeps it for the outcome card", () => {
    let state = event(begin(), { type: "milestone", milestoneId: "m1", status: "started", title: "准备" });
    state = event(state, { type: "receipt", status: "completed", summary: "全部完成", receipt: {
      milestones: [{ id: "m1", title: "准备", status: "completed" }],
      filesChanged: [{ path: "src/a.ts", added: 3, removed: 1 }],
      verify: [{ command: "npm test", ok: true, output: "ok" }],
      branch: "piko/task-abcd", commits: ["ab12"], openQuestions: [],
    } });
    const done = event(state, { type: "completed" });
    expect(done.terminal).toMatchObject({ status: "completed" });
    expect(done.receipt).toMatchObject({ status: "completed", summary: "全部完成",
      receipt: { branch: "piko/task-abcd", commits: ["ab12"], filesChanged: [{ path: "src/a.ts", added: 3, removed: 1 }] } });
    expect(done.milestones).toHaveLength(1);
  });

  it("restores delegated events from a snapshot replay", () => {
    const snapshot = { requestId: "current", conversationId: "conversation", cwd: null,
      prompt: "重构模块", response: "", eventSequence: 6,
      events: [
        { type: "contract-proposed" as const, requestId: "current", contractId: "c1", contract: { goal: "重构", milestones: [] } },
        { type: "milestone" as const, requestId: "current", milestoneId: "m1", status: "started", title: "准备" },
        { type: "notice" as const, requestId: "current", level: "warn", text: "安装依赖" },
        { type: "receipt" as const, requestId: "current", status: "suspended", receipt: { branch: "piko/task-x" } },
      ] };
    const restored = agentTaskReducer(initialAgentTaskState, { type: "restore", snapshot });
    expect(restored.pendingContract?.contractId).toBe("c1");
    expect(restored.milestones[0]).toMatchObject({ id: "m1", status: "started" });
    expect(restored.notices[0]).toEqual({ level: "warn", text: "安装依赖" });
    expect(restored.receipt?.receipt.branch).toBe("piko/task-x");
    const done = agentTaskReducer(restored, { type: "event", event: { type: "cancelled", requestId: "current" } });
    expect(done.busy).toBe(false);
    expect(done.pendingContract).toBeNull();
    expect(done.receipt?.receipt.branch).toBe("piko/task-x");
  });
});

it("restores a Rust task projection with its pending approvals and terminal state", () => {
  const snapshot = { requestId: "current", conversationId: "conversation", cwd: null,
    prompt: "hello", response: "partial", eventSequence: 4,
    events: [
      { type: "tool-start" as const, requestId: "current", toolCallId: "read", tool: "read" },
      { type: "tool-end" as const, requestId: "current", toolCallId: "read", output: "verified" },
      { type: "approval" as const, requestId: "current", approvalId: "approve", tool: "write" },
    ] };
  const restored = agentTaskReducer(initialAgentTaskState, { type: "restore", snapshot });
  expect(restored.busy).toBe(true);
  expect(restored.tools[0]).toMatchObject({ status: "完成", output: "verified" });
  expect(restored.approvals[0].id).toBe("approve");
  const done = agentTaskReducer(restored, { type: "event", event: { type: "completed", requestId: "current" } });
  expect(done).toMatchObject({ busy: false, approvals: [], terminal: { status: "completed" } });
});
