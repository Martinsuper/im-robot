// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DailyKnowledgePanel } from "./DailyKnowledgePanel";
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("../app/appRuntime", () => ({ isTauriRuntime: true }));
vi.mock("./KnowledgePanel", () => ({
  KnowledgePanel: () => <div>文件资料管理</div>,
}));
vi.mock("./MemoryDetail", () => ({ MemoryDetail: () => <div>知识详情</div> }));
const status = {
  autoStore: true,
  lastRunAt: 100,
  nextRunAt: 86500,
  knowledgeCount: 1,
  pendingCount: 2,
  report: { collected: 1, duplicates: 0, archived: 0 },
};
beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(
    async (command: string, args?: { input?: { memoryType: string } }) => {
      if (command === "knowledge_get_maintenance_status") return status;
      if (command === "knowledge_maintain")
        return { collected: 1, duplicates: 2, archived: 3 };
      if (command === "list_memories")
        return args?.input?.memoryType === "semantic"
          ? [
              {
                id: "m1",
                title: "项目测试方式",
                content: "这个项目使用 cargo test",
                tags: [],
                memoryType: "semantic",
                updatedAt: 100,
                expiresAt: null,
              },
            ]
          : [];
      return status;
    },
  );
});
afterEach(cleanup);
it("shows accumulated knowledge first and keeps imported references optional", async () => {
  const onReview = vi.fn();
  render(<DailyKnowledgePanel onReview={onReview} />);
  await screen.findByText("项目测试方式");
  expect(screen.queryByText("文件资料管理")).toBeNull();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "nonexistent" },
  });
  expect(screen.queryByText("项目测试方式")).toBeNull();
  expect(screen.getByText("没有匹配的知识。")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "待确认（2）" }));
  expect(onReview).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByText("参考资料（可选）"));
  await screen.findByText("文件资料管理");
});
it("runs maintenance, reports actual outcomes and persists the auto-store switch", async () => {
  render(<DailyKnowledgePanel onReview={() => {}} />);
  await screen.findByText("1 条知识");
  fireEvent.click(screen.getByRole("button", { name: "立即整理" }));
  await screen.findByText(/收录 1 条，跳过重复 2 条，归档过期 3 条/);
  await waitFor(() =>
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole("checkbox"));
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("knowledge_configure_maintenance", {
      autoStore: false,
    }),
  );
});
it("shows maintenance failures without discarding existing knowledge", async () => {
  render(<DailyKnowledgePanel onReview={() => {}} />);
  await screen.findByText("项目测试方式");
  invokeMock.mockRejectedValueOnce(new Error("整理失败"));
  fireEvent.click(screen.getByRole("button", { name: "立即整理" }));
  await screen.findByRole("alert");
  expect(screen.getByText("项目测试方式")).toBeTruthy();
  expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
});
