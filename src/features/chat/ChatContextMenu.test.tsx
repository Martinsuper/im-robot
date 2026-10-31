// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectInfo } from "./agentTypes";

const { dialogOpen, invokeV2, listScheduledTasks, createScheduledTask, cancelScheduledTask } = vi.hoisted(() => ({
  dialogOpen: vi.fn(),
  invokeV2: vi.fn(),
  listScheduledTasks: vi.fn(),
  createScheduledTask: vi.fn(),
  cancelScheduledTask: vi.fn(),
}));

vi.mock("../i18n/I18nProvider", () => ({ useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialogOpen }));
vi.mock("../app/appRuntime", () => ({ isTauriRuntime: true, runCommand: vi.fn() }));
vi.mock("./agentWire", () => ({ invokeV2, listScheduledTasks, createScheduledTask, cancelScheduledTask }));

import { ChatContextMenu } from "./ChatContextMenu";

afterEach(cleanup);
beforeEach(() => {
  invokeV2.mockReset();
  listScheduledTasks.mockReset();
  createScheduledTask.mockReset();
  cancelScheduledTask.mockReset();
  dialogOpen.mockReset().mockResolvedValue(null);
});

const base = {
  cwd: "", disabled: false, open: true, onToggle: vi.fn(), onChoose: vi.fn(), onSelectProject: vi.fn(),
  favoritesOpen: false, onToggleFavorites: vi.fn(), favoritesButtonRef: { current: null }, favorites: [],
  onSelect: vi.fn(), onRemove: vi.fn(),
};
const project = (overrides: Partial<ProjectInfo>): ProjectInfo => ({ id: "p1", name: "im-robot", path: "/repo/im-robot", ...overrides });

it("lists recent projects first and marks the current one", async () => {
  invokeV2.mockResolvedValue([project({ id: "p2", name: "old", lastOpenedAt: 1 }), project({ lastOpenedAt: 9 })]);
  render(<ChatContextMenu {...base} projectId="p1" />);
  const items = await screen.findAllByRole("button", { name: /im-robot|old/ });
  expect(items[0].textContent).toBe("im-robot");
  expect(items[0].getAttribute("aria-pressed")).toBe("true");
  expect(invokeV2).toHaveBeenCalledWith("project_list");
  fireEvent.click(items[0]);
  expect(base.onSelectProject).toHaveBeenCalledWith(expect.objectContaining({ id: "p1", path: "/repo/im-robot" }));
});

it("creates a project from the directory dialog and selects it", async () => {
  invokeV2.mockResolvedValue([]);
  dialogOpen.mockResolvedValue("/repo/next");
  invokeV2.mockImplementation(async (command: string, args?: Record<string, unknown>) => command === "project_list" ? [] : { id: "p9", name: "next", path: args?.path });
  render(<ChatContextMenu {...base} />);
  await screen.findByText("还没有项目，选择目录即可新建。");
  fireEvent.click(screen.getByRole("button", { name: "新建项目" }));
  await waitFor(() => expect(base.onSelectProject).toHaveBeenCalledWith({ id: "p9", name: "next", path: "/repo/next" }));
  expect(dialogOpen).toHaveBeenCalled();
  expect(invokeV2).toHaveBeenCalledWith("project_create", { path: "/repo/next" });
});

it("shows the plain directory picker and reports project failures without blocking it", async () => {
  invokeV2.mockRejectedValue(new Error("no registry"));
  render(<ChatContextMenu {...base} cwd="/tmp/work" />);
  expect(screen.getByTestId("workspace-directory").textContent).toContain("work");
  await screen.findByRole("alert");
  fireEvent.click(screen.getByTestId("workspace-directory"));
  expect(base.onChoose).toHaveBeenCalledOnce();
});

it("keeps the project panel hidden while the context menu is closed", () => {
  invokeV2.mockResolvedValue([]);
  render(<ChatContextMenu {...base} open={false} />);
  expect(invokeV2).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "新建项目" })).toBeNull();
});

describe("定时委托（doc 18 §9）", () => {
  beforeEach(() => {
    invokeV2.mockResolvedValue([]);
    listScheduledTasks.mockResolvedValue([]);
  });

  it("creates a scheduled delegation from the lightweight form with the picked project", async () => {
    invokeV2.mockResolvedValue([project({})]);
    createScheduledTask.mockResolvedValue(null);
    render(<ChatContextMenu {...base} cwd="/repo/here" />);
    fireEvent.click(await screen.findByRole("button", { name: "定时委托" }));
    fireEvent.change(screen.getByLabelText("任务提示词"), { target: { value: "每晚整理构建日志" } });
    fireEvent.change(screen.getByRole("combobox", { name: "项目" }), { target: { value: "p1" } });
    fireEvent.change(screen.getByLabelText("执行时间"), { target: { value: "2030-01-01T09:00" } });
    fireEvent.click(screen.getByRole("button", { name: "创建定时委托" }));
    await waitFor(() => expect(createScheduledTask).toHaveBeenCalledWith({
      prompt: "每晚整理构建日志", projectId: "p1", scheduledAt: new Date("2030-01-01T09:00").toISOString(),
    }));
    await screen.findByText("定时委托已创建。");
  });

  it("falls back to the conversation workspace when no project is picked", async () => {
    createScheduledTask.mockResolvedValue(null);
    render(<ChatContextMenu {...base} cwd="/repo/here" />);
    fireEvent.click(await screen.findByRole("button", { name: "定时委托" }));
    fireEvent.change(screen.getByLabelText("任务提示词"), { target: { value: "备份数据" } });
    fireEvent.change(screen.getByLabelText("执行时间"), { target: { value: "2030-01-01T09:00" } });
    fireEvent.click(screen.getByRole("button", { name: "创建定时委托" }));
    await waitFor(() => expect(createScheduledTask).toHaveBeenCalledWith({
      prompt: "备份数据", workspace: "/repo/here", scheduledAt: new Date("2030-01-01T09:00").toISOString(),
    }));
  });

  it("rejects past times with a visible message instead of calling the host", async () => {
    createScheduledTask.mockResolvedValue(null);
    render(<ChatContextMenu {...base} />);
    fireEvent.click(await screen.findByRole("button", { name: "定时委托" }));
    fireEvent.change(screen.getByLabelText("任务提示词"), { target: { value: "太晚了" } });
    fireEvent.change(screen.getByLabelText("执行时间"), { target: { value: "2000-01-01T09:00" } });
    fireEvent.click(screen.getByRole("button", { name: "创建定时委托" }));
    await screen.findByText("请填写提示词并选择将来的时间。");
    expect(createScheduledTask).not.toHaveBeenCalled();
  });

  it("lists pending delegations and cancels one from the same menu", async () => {
    listScheduledTasks.mockResolvedValue([
      { id: "s1", prompt: "整理日志", scheduledAt: "2030-01-01T09:00:00Z", status: "pending" },
      { id: "s2", prompt: "已取消的", scheduledAt: "2030-01-01T09:00:00Z", status: "cancelled" },
    ]);
    cancelScheduledTask.mockResolvedValue(null);
    render(<ChatContextMenu {...base} />);
    fireEvent.click(await screen.findByRole("button", { name: "定时委托" }));
    await screen.findByText("整理日志");
    expect(screen.queryByText("已取消的")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "取消：整理日志" }));
    await waitFor(() => expect(cancelScheduledTask).toHaveBeenCalledWith("s1"));
    await screen.findByText("暂无待执行的定时委托。");
  });

  it("loads the pending list only after the schedule section expands", async () => {
    render(<ChatContextMenu {...base} />);
    expect(listScheduledTasks).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "定时委托" }));
    await waitFor(() => expect(listScheduledTasks).toHaveBeenCalledTimes(1));
  });
});
