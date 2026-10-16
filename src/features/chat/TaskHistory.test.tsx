// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskHistory, type TaskRecord } from "./TaskHistory";

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
