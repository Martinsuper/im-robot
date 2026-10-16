// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskOutcome } from "./TaskOutcome";
import { fileOperationTargets, summarizeSteps } from "./taskOutcomeModel";
import type { ToolActivity } from "./agentTypes";

afterEach(cleanup);
const terminal = { requestId: "request-1", status: "completed" as const };
const step = (id: string, name: string, status: string, path?: unknown): ToolActivity => ({ id, name, status, arguments: { path } });

it("does not show an execution card for ordinary chat or a running task", () => {
  const { container, rerender } = render(<TaskOutcome terminal={terminal} tools={[]} busy={false} onInspect={vi.fn()} />);
  expect(container.innerHTML).toBe("");
  rerender(<TaskOutcome terminal={null} tools={[step("w", "write", "执行中", "a.txt")]} busy onInspect={vi.fn()} />);
  expect(container.innerHTML).toBe("");
});

it("keeps failed and unknown steps visible even when the agent reports completion", () => {
  const inspect = vi.fn();
  render(<TaskOutcome terminal={terminal} tools={[
    step("r", "read", "完成"), step("w", "write", "失败", "failed.txt"), step("s", "bash", "结果未知"),
  ]} busy={false} onInspect={inspect} />);
  expect(screen.getByText("执行已结束，有步骤需要核对")).toBeTruthy();
  expect(screen.getByText("1 项工具返回成功 · 1 项报告失败 · 1 项结果未知")).toBeTruthy();
  expect(screen.queryByText("文件操作目标")).toBeNull();
  expect(inspect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "只读核对本轮结果" }));
  expect(inspect).toHaveBeenCalledWith("request-1");
});

it("uses only successful write/edit arguments for file targets, never model output", () => {
  const tools = [step("1", "write", "完成", "report.md"), step("2", "edit", "完成", "report.md"),
    step("3", "write", "失败", "absent.md"), { ...step("4", "bash", "完成"), output: "Saved /fake/claimed.md" },
    step("5", "write", "完成", 123)];
  expect(fileOperationTargets(tools)).toEqual(["report.md"]);
  expect(summarizeSteps(["completed", "failed", "unknown"])).toEqual({ returned: 1, failed: 1, unknown: 1 });
});

it("copies the file target and renders tool evidence as text", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const { container } = render(<TaskOutcome terminal={terminal} tools={[{
    ...step("1", "write", "完成", "report.md"), output: "<script>window.bad=true</script>",
  }]} busy={false} onInspect={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "复制路径 report.md" }));
  await screen.findByText("已复制");
  expect(writeText).toHaveBeenCalledWith("report.md");
  expect(container.querySelector("script")).toBeNull();
  expect(screen.getByText("<script>window.bad=true</script>")).toBeTruthy();
});

it("reports clipboard failure and disables inspection while busy", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
  render(<TaskOutcome terminal={{ ...terminal, status: "cancelled" }} tools={[step("w", "write", "完成", "a.txt")]} busy onInspect={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "复制路径 a.txt" }));
  await screen.findByRole("alert");
  expect((screen.getByRole("button", { name: "只读核对本轮结果" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("执行已停止")).toBeTruthy();
});
