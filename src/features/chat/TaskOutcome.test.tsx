// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../i18n/I18nProvider", () => ({ useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }) }));
const { getTaskSteps } = vi.hoisted(() => ({ getTaskSteps: vi.fn() }));
vi.mock("./agentWire", () => ({ getTaskSteps }));
import { TaskOutcome } from "./TaskOutcome";
import { fileOperationTargets, stepStatusLabel, summarizeSteps } from "./taskOutcomeModel";
import type { ReceiptRecord, ToolActivity } from "./agentTypes";

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

const receipt: ReceiptRecord = {
  status: "completed",
  summary: "两个里程碑全部通过验收",
  receipt: {
    milestones: [{ id: "m1", title: "准备", status: "completed" }, { id: "m2", title: "实现", status: "failed", note: "验收未通过" }],
    filesChanged: [{ path: "src/login.ts", added: 12, removed: 3 }],
    verify: [{ command: "npm run verify", ok: false, output: "1) login flows" + "x".repeat(500) }],
    notices: [{ level: "warn", text: "安装了依赖" }],
    branch: "piko/task-ab12",
    commits: ["ab12ef3"],
    openQuestions: ["是否保留旧接口"],
  },
};

it("renders the receipt with milestones, diffstat, verify output and branch", () => {
  const { container } = render(<TaskOutcome terminal={terminal} tools={[step("t", "read", "完成")]} busy={false} receipt={receipt} onInspect={vi.fn()} />);
  expect(screen.getByText("任务已完成")).toBeTruthy();
  expect(screen.getByText("两个里程碑全部通过验收")).toBeTruthy();
  expect(screen.getByText("实现")).toBeTruthy();
  expect(screen.getByText("src/login.ts")).toBeTruthy();
  expect(screen.getByText("+12 −3")).toBeTruthy();
  expect(screen.getByText("npm run verify")).toBeTruthy();
  expect(screen.getByText("未通过")).toBeTruthy();
  expect(screen.getByText(/1\) login flows/)).toBeTruthy();
  expect(screen.getByText("piko/task-ab12")).toBeTruthy();
  expect(screen.getByText("ab12ef3")).toBeTruthy();
  expect(screen.getByText("是否保留旧接口")).toBeTruthy();
  expect(screen.getByText("安装了依赖").className).toContain("task-outcome__notice--warn");
  // 回执模式下旧的工具计数与自述式文件列表被回执字段取代。
  expect(screen.queryByText("文件操作目标")).toBeNull();
  expect(container.querySelector("script")).toBeNull();
});

it("opens receipt files in the editor and copies paths", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const onOpenFile = vi.fn();
  render(<TaskOutcome terminal={terminal} tools={[]} busy={false} receipt={receipt} onInspect={vi.fn()} onOpenFile={onOpenFile} />);
  fireEvent.click(screen.getByRole("button", { name: "在编辑器打开 src/login.ts" }));
  expect(onOpenFile).toHaveBeenCalledWith("src/login.ts");
  fireEvent.click(screen.getByRole("button", { name: "复制路径 src/login.ts" }));
  await screen.findByText("已复制");
  expect(writeText).toHaveBeenCalledWith("src/login.ts");
});

it("sending the reject feedback resumes the task and accepting closes the card", () => {
  const onResumeWithFeedback = vi.fn();
  const { container } = render(<TaskOutcome terminal={terminal} tools={[]} busy={false} receipt={receipt}
    onInspect={vi.fn()} onResumeWithFeedback={onResumeWithFeedback} />);
  fireEvent.click(screen.getByRole("button", { name: "打回重跑" }));
  const feedback = screen.getByLabelText("打回反馈") as HTMLTextAreaElement;
  fireEvent.change(feedback, { target: { value: "第二个里程碑验收没过，请修复后重跑" } });
  fireEvent.click(screen.getByRole("button", { name: "发送反馈并续跑" }));
  expect(onResumeWithFeedback).toHaveBeenCalledWith("request-1", "第二个里程碑验收没过，请修复后重跑");
  expect(screen.queryByLabelText("打回反馈")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "接受并关闭" }));
  expect(container.innerHTML).toBe("");
});

it("renders the suspended receipt title without feedback senders while busy", () => {
  render(<TaskOutcome terminal={{ ...terminal, status: "failed" }} tools={[]} busy
    receipt={{ ...receipt, status: "suspended" }} onInspect={vi.fn()} onResumeWithFeedback={vi.fn()} />);
  expect(screen.getByText("任务已挂起收尾")).toBeTruthy();
  expect((screen.getByRole("button", { name: "打回重跑" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "发送反馈并续跑" })).toBeNull();
});

describe("完整流水（doc 18 §9）", () => {
  beforeEach(() => getTaskSteps.mockReset());

  it("loads the full ledger including archived entries on demand", async () => {
    getTaskSteps.mockResolvedValue({ steps: [
      { id: "s1", tool: "read", status: "completed" },
      { id: "s2", tool: "write", status: "完成" },
      { id: "s3", tool: "bash", status: "failed" },
    ], archivedCount: 2 });
    render(<TaskOutcome terminal={terminal} tools={[step("t", "read", "完成")]} busy={false} onInspect={vi.fn()} />);
    fireEvent.click(screen.getByText("查看完整流水"));
    expect(await screen.findByText("read · 工具已返回")).toBeTruthy();
    expect(screen.getByText("write · 工具已返回")).toBeTruthy();
    expect(screen.getByText("bash · 失败")).toBeTruthy();
    expect(screen.getByText("含 2 条归档")).toBeTruthy();
    expect(getTaskSteps).toHaveBeenCalledWith("request-1", true);
  });

  it("shows the empty state and normalizes malformed entries", async () => {
    getTaskSteps.mockResolvedValue({ steps: [{ tool: "" }, "junk", null], archivedCount: 0 });
    render(<TaskOutcome terminal={terminal} tools={[step("t", "read", "完成")]} busy={false} onInspect={vi.fn()} />);
    fireEvent.click(screen.getByText("查看完整流水"));
    await screen.findByText("没有已记录的工具步骤。");
    expect(document.querySelectorAll(".task-steps__list li")).toHaveLength(0);
    expect(screen.queryByText(/条归档/)).toBeNull();
  });

  it("labels archived english and live chinese statuses with one vocabulary", () => {
    expect(stepStatusLabel("completed")).toBe("工具已返回");
    expect(stepStatusLabel("完成")).toBe("工具已返回");
    expect(stepStatusLabel("failed")).toBe("失败");
    expect(stepStatusLabel("结果未知")).toBe("结果未知");
    expect(stepStatusLabel("mystery")).toBe("mystery");
  });
});
