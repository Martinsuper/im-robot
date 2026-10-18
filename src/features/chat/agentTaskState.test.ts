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
