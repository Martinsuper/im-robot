// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { invokeMock, openMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  openMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock }));
const config = {
  enabled: false,
  endpoint: "http://localhost:11434/v1/embeddings",
  model: "bge-m3",
  allowRemote: false,
  revision: 1,
};
const doc = {
  id: "d1",
  title: "部署.md",
  path: "/projects/piko/部署.md",
  scope: "piko",
  updatedAt: 1,
  chunkCount: 2,
};
let KnowledgePanel: typeof import("./KnowledgePanel").KnowledgePanel;
beforeEach(async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
  KnowledgePanel = (await import("./KnowledgePanel")).KnowledgePanel;
  invokeMock.mockReset();
  openMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "knowledge_list_documents") return [doc];
    if (command === "knowledge_get_settings") return config;
    if (command === "knowledge_import")
      return { imported: 1, unchanged: 0, errors: [] };
    if (command === "knowledge_save_settings") return config;
    return {};
  });
});
afterEach(cleanup);
describe("knowledge library", () => {
  it("preserves the document project when refreshing from a different search scope", async () => {
    render(<KnowledgePanel />);
    await screen.findByText("部署.md");
    fireEvent.change(screen.getByLabelText("项目范围（可选）"), {
      target: { value: "another-project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "重新索引文件" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("knowledge_import", {
        paths: [doc.path],
        scope: "piko",
      }),
    );
    await screen.findByText(/已导入或更新 1 个文件/);
  });
  it("shows partial import failures without losing successfully imported documents", async () => {
    openMock.mockResolvedValue(["/notes"]);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "knowledge_list_documents") return [doc];
      if (command === "knowledge_get_settings") return config;
      if (command === "knowledge_import")
        return {
          imported: 1,
          unchanged: 0,
          errors: ["扫描.pdf：未提取到文字"],
        };
      return {};
    });
    render(<KnowledgePanel />);
    await screen.findByText("部署.md");
    fireEvent.click(screen.getByRole("button", { name: "导入文件夹" }));
    await screen.findByText("扫描.pdf：未提取到文字");
    expect(screen.getByText("部署.md")).toBeTruthy();
  });
  it("shows evidence and an explicit keyword fallback when embedding is unavailable", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "knowledge_list_documents") return [doc];
      if (command === "knowledge_get_settings") return config;
      if (command === "knowledge_search")
        return {
          hits: [
            {
              id: "c1",
              title: "部署.md",
              source: doc.path,
              sourceType: "document",
              locator: "第 12 行",
              scope: "piko",
              content: "发布前执行数据库迁移。",
              score: 0.02,
            },
          ],
          warning: "连接失败；本次使用关键词检索",
        };
      return {};
    });
    render(<KnowledgePanel />);
    await screen.findByText("部署.md");
    fireEvent.change(screen.getByLabelText("搜索记忆和资料"), {
      target: { value: "发布前做什么" },
    });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await screen.findByText("发布前执行数据库迁移。");
    expect(screen.getByText(/第 12 行/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("关键词检索");
  });
  it("never sends a preserved API key back to the browser and makes cloud use opt-in", async () => {
    render(<KnowledgePanel />);
    await screen.findByText("部署.md");
    fireEvent.click(screen.getByText("语义检索设置"));
    expect(
      (screen.getByLabelText(/允许将问题/) as HTMLInputElement).checked,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("knowledge_save_settings", {
        input: config,
        apiKeyUpdate: null,
      }),
    );
  });
});
