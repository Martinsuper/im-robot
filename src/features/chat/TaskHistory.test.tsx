// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../i18n/I18nProvider", () => ({ useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }) }));
const { getTaskSteps } = vi.hoisted(() => ({ getTaskSteps: vi.fn() }));
vi.mock("./agentWire", () => ({ getTaskSteps }));
import { TaskHistory } from "./TaskHistory";
import { contractInterrupted, hasContractTrace, type TaskRecord } from "./taskOutcomeModel";

const { command } = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../app/appRuntime", () => ({ isTauriRuntime: true, runCommand: command }));
afterEach(cleanup);
beforeEach(() => command.mockReset());
const interrupted: TaskRecord = {
  requestId: "request-1", conversationId: "conversation-1", status: "interrupted", startedAt: 1, updatedAt: 2,
  steps: [{ id: "read", tool: "read", status: "completed" }, { id: "write", tool: "write", status: "unknown" }],
};

it("restores interrupted steps without automatically replaying operations", async () => {
  command.mockResolvedValue([interrupted]);
  render(<TaskHistory busy={false} />);
  await screen.findByText("任务记录 · 有中断任务待核对");
  expect(screen.getByText("read · 工具已返回")).toBeTruthy();
  expect(screen.getByText("write · 结果未知")).toBeTruthy();
  expect(screen.getByText(/可能已有部分操作完成/)).toBeTruthy();
  expect(command.mock.calls).toEqual([["agent_list_tasks"]]);
  expect(screen.queryByRole("button", { name: /重试|继续执行/ })).toBeNull();
});

it("read failure is visible and refresh recovers the records", async () => {
  command.mockRejectedValueOnce(new Error("读取失败")).mockResolvedValueOnce([interrupted]);
  render(<TaskHistory busy={false} />);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "刷新任务记录" }));
  await screen.findByText("write · 结果未知");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("refreshes the durable terminal state when execution stops", async () => {
  command.mockResolvedValueOnce([{ ...interrupted, status: "running" }]);
  const { rerender } = render(<TaskHistory busy />);
  await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
  command.mockResolvedValueOnce([{ ...interrupted, status: "completed" }]);
  await act(async () => rerender(<TaskHistory busy={false} />));
  await screen.findByText("已结束");
  expect(command.mock.calls.every(([name]) => name === "agent_list_tasks")).toBe(true);
});

it("inspection is explicit and unavailable while another task runs", async () => {
  command.mockResolvedValue([interrupted]);
  const inspect = vi.fn();
  const { rerender } = render(<TaskHistory busy={false} onInspect={inspect} />);
  const button = await screen.findByRole("button", { name: "只读核对结果" });
  expect(inspect).not.toHaveBeenCalled();
  fireEvent.click(button);
  expect(inspect).toHaveBeenCalledWith(interrupted);
  rerender(<TaskHistory busy onInspect={inspect} />);
  expect((screen.getByRole("button", { name: "只读核对结果" }) as HTMLButtonElement).disabled).toBe(true);
});

describe("契约等待中断的恢复（doc 18 §9）", () => {
  beforeEach(() => {
    command.mockReset();
    getTaskSteps.mockReset();
  });

  const contractTask: TaskRecord = {
    ...interrupted, contractPending: true, prompt: "重构登录模块", cwd: "/repo/im-robot",
  };

  it("offers restart instead of resume for tasks interrupted while awaiting contract confirmation", async () => {
    command.mockResolvedValue([contractTask]);
    const onRestart = vi.fn(), onResume = vi.fn();
    render(<TaskHistory busy={false} onResume={onResume} onRestart={onRestart} />);
    await screen.findByText("任务在等待契约确认时中断");
    expect(screen.queryByRole("button", { name: "安全续跑" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新发起" }));
    expect(onRestart).toHaveBeenCalledWith(contractTask);
    expect(onResume).not.toHaveBeenCalled();
  });

  it("treats a waiting contract task the same way and keeps plain tasks on resume", async () => {
    command.mockResolvedValue([
      { ...interrupted, requestId: "request-wait", status: "waiting", contractId: "c-77", steps: [] },
      { ...interrupted, requestId: "request-plain", contractPending: false },
    ]);
    const onRestart = vi.fn(), onResume = vi.fn();
    render(<TaskHistory busy={false} onResume={onResume} onRestart={onRestart} />);
    const restarts = await screen.findAllByRole("button", { name: "重新发起" });
    expect(restarts).toHaveLength(1);
    fireEvent.click(restarts[0]);
    expect(onRestart).toHaveBeenCalledWith(expect.objectContaining({ requestId: "request-wait" }));
    expect(screen.getByRole("button", { name: "安全续跑" })).toBeTruthy();
    expect(onResume).not.toHaveBeenCalled();
  });

  it("detects contract traces across explicit fields and step markers", () => {
    expect(hasContractTrace({ ...interrupted, contractPending: true })).toBe(true);
    expect(hasContractTrace({ ...interrupted, contractId: "c-77" })).toBe(true);
    expect(hasContractTrace({ ...interrupted, steps: [{ id: "s", tool: "contract", status: "waiting" }] })).toBe(true);
    expect(hasContractTrace(interrupted)).toBe(false);
    expect(contractInterrupted({ ...interrupted, status: "completed", contractPending: true })).toBe(false);
    expect(contractInterrupted({ ...interrupted, status: "waiting", contractId: "c-77" })).toBe(true);
  });

  it("loads the archived step ledger for a history record", async () => {
    command.mockResolvedValue([contractTask]);
    getTaskSteps.mockResolvedValue({ steps: [{ id: "s1", tool: "read", status: "completed" }], archivedCount: 3 });
    render(<TaskHistory busy={false} />);
    fireEvent.click(await screen.findByText("查看完整流水"));
    expect(await screen.findByText("含 3 条归档")).toBeTruthy();
    expect(document.querySelectorAll(".task-steps__list li")).toHaveLength(1);
    expect(getTaskSteps).toHaveBeenCalledWith("request-1", true);
  });
});
