// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../i18n/I18nProvider", () => ({ useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }) }));
const { readTaskLog } = vi.hoisted(() => ({ readTaskLog: vi.fn() }));
vi.mock("./agentWire", () => ({ readTaskLog }));
import { AgentActivity } from "./AgentActivity";

afterEach(cleanup);
const base = { tools: [], approvals: [], workspaceRequired: false, status: "", onApprove: vi.fn(), onChooseWorkspace: vi.fn(), onCancelWorkspace: vi.fn() };
it("shows approval in the reply without another input or automatic approval", () => {
  const onApprove = vi.fn();
  const { container } = render(<AgentActivity {...base} onApprove={onApprove} approvals={[{ id: "a", tool: "bash", arguments: { command: "pwd" } }]} />);
  expect(container.querySelectorAll("input, textarea, form")).toHaveLength(0);
  expect(onApprove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("允许此次操作"));
  expect(onApprove).toHaveBeenCalledWith("a", true);
});
it("requests a directory only when the running task needs one", () => {
  const choose = vi.fn(), cancel = vi.fn();
  render(<AgentActivity {...base} workspaceRequired onChooseWorkspace={choose} onCancelWorkspace={cancel} />);
  fireEvent.click(screen.getByText("选择文件夹并继续"));
  fireEvent.click(screen.getByText("取消此次操作"));
  expect(choose).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
});

it("keeps the flat tool ledger for companion tasks without milestones", () => {
  const { container } = render(<AgentActivity {...base} tools={[{ id: "t1", name: "read", arguments: {}, status: "完成" }]} />);
  expect(screen.getByText("执行详情 · 1 项操作")).toBeTruthy();
  expect(container.querySelector(".agent-activity__timeline")).toBeNull();
});

it("renders the milestone timeline with the running milestone highlighted and tools folded inside", () => {
  render(<AgentActivity {...base} milestones={[
    { id: "m1", status: "completed", title: "准备" },
    { id: "m2", status: "started", title: "实现" },
    { id: "m3", status: "skipped", title: "扩展" },
    { id: "m4", status: "failed", title: "发布" },
  ]} tools={[
    { id: "t1", name: "read", arguments: {}, status: "完成", milestoneId: "m2" },
    { id: "t2", name: "bash", arguments: {}, status: "失败", milestoneId: "m2" },
    { id: "t0", name: "read", arguments: {}, status: "完成" },
  ]} />);
  const current = screen.getByText("实现 · 执行中").closest("li");
  expect(current?.getAttribute("aria-current")).toBe("step");
  expect(screen.getByText("准备 · 已完成")).toBeTruthy();
  expect(screen.getByText("扩展 · 已跳过")).toBeTruthy();
  expect(screen.getByText("发布 · 失败")).toBeTruthy();
  // 工具流水折叠为当前里程碑下的明细；无归属的操作保留为启动阶段分组。
  expect(screen.getByText("操作明细 · 2 项")).toBeTruthy();
  expect(screen.getByText("启动阶段操作 · 1 项")).toBeTruthy();
  expect(screen.queryByText("执行详情 · 3 项操作")).toBeNull();
});

it("shows notices inline with warn styling", () => {
  const { container } = render(<AgentActivity {...base} notices={[{ level: "warn", text: "安装了依赖" }, { level: "info", text: "新增了计划外文件" }]} />);
  const warn = screen.getByText("安装了依赖");
  expect(warn.className).toContain("agent-activity__notice--warn");
  expect(screen.getByText("新增了计划外文件").className).not.toContain("warn");
  expect(container.querySelector("details")).toBeNull();
});

describe("任务日志查看与批注（doc 18 §9）", () => {
  beforeEach(() => readTaskLog.mockReset());

  it("renders the log content with a truncation note and sends annotations through the callback", async () => {
    readTaskLog.mockResolvedValue({ exists: true, content: "# 步骤\n- 完成登录", truncated: true });
    const onAnnotate = vi.fn();
    render(<AgentActivity {...base} requestId="req-log" milestones={[{ id: "m1", status: "started", title: "实现" }]} onAnnotate={onAnnotate} />);
    fireEvent.click(screen.getByText("任务日志"));
    expect(await screen.findByText(/完成登录/)).toBeTruthy();
    expect(screen.getByText("日志过长，仅显示前 256KB。")).toBeTruthy();
    expect(readTaskLog).toHaveBeenCalledWith("req-log");
    fireEvent.change(screen.getByLabelText("任务批注"), { target: { value: "注意超时处理" } });
    fireEvent.click(screen.getByRole("button", { name: "发送批注" }));
    expect(onAnnotate).toHaveBeenCalledWith("注意超时处理");
    expect((screen.getByLabelText("任务批注") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByText("批注将在下一里程碑边界生效。")).toBeTruthy();
  });

  it("shows an empty state when the log file does not exist yet", async () => {
    readTaskLog.mockResolvedValue({ exists: false, content: "" });
    render(<AgentActivity {...base} requestId="req-empty" milestones={[{ id: "m1", status: "started" }]} onAnnotate={vi.fn()} />);
    fireEvent.click(screen.getByText("任务日志"));
    await screen.findByText("任务还没有日志。");
  });

  it("keeps the log entry out of companion timelines and reports read failures", async () => {
    const companion = render(<AgentActivity {...base} requestId="req-chat" tools={[{ id: "t1", name: "read", arguments: {}, status: "完成" }]} onAnnotate={vi.fn()} />);
    expect(companion.container.querySelector(".agent-activity__tasklog")).toBeNull();
    companion.unmount();
    readTaskLog.mockRejectedValueOnce(new Error("boom"));
    render(<AgentActivity {...base} requestId="req-err" milestones={[{ id: "m1", status: "started" }]} onAnnotate={vi.fn()} />);
    fireEvent.click(screen.getByText("任务日志"));
    await screen.findByText("任务日志读取失败，请重试。");
  });
});
