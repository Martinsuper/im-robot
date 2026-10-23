// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { invokeMock, listenMock, openMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
  openMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock }));
let MemoryVaultPanel: typeof import("./MemoryVaultPanel").MemoryVaultPanel;
const report = {
  syncedAt: 1,
  exported: 0,
  imported: 0,
  removed: 0,
  issues: [],
  error: null,
};
const initial = {
  config: { enabled: true, directory: "/notes/piko", pausedReason: null },
  report,
  trackedCount: 2,
  persistent: true,
};
const issue = {
  memoryId: "m1",
  path: "用户档案/test.md",
  kind: "bothChanged",
  message: "两侧均已修改",
  canResolve: true,
};
const comparison = {
  memoryId: "m1",
  path: issue.path,
  pikoTitle: "住址",
  pikoContent: "上海",
  fileTitle: "住址",
  fileContent: "杭州",
  pikoVersion: "db-hash",
  fileVersion: "file-hash",
  active: true,
  pikoMetadata: "分类：用户档案 · 重要度：3",
  fileMetadata: "分类：用户档案 · 重要度：5",
};
beforeEach(async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
  MemoryVaultPanel = (await import("./MemoryVaultPanel")).MemoryVaultPanel;
  invokeMock.mockReset();
  listenMock.mockReset().mockResolvedValue(() => {});
  openMock.mockReset();
  invokeMock.mockImplementation(
    async (
      command: string,
      args?: { enabled: boolean; directory: string | null },
    ) => {
      if (command === "memory_vault_status") return initial;
      if (command === "memory_vault_configure")
        return {
          ...initial,
          config: {
            ...initial.config,
            enabled: args?.enabled,
            directory: args?.directory ?? initial.config.directory,
          },
        };
      if (command === "memory_vault_sync") return report;
      return {};
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function expand() {
  fireEvent.click(screen.getByText("Markdown 记忆库", { exact: false }));
}
describe("Markdown memory vault", () => {
  it("shows the actual directory and can pause without deleting files", async () => {
    render(<MemoryVaultPanel />);
    expand();
    await screen.findByText("/notes/piko");
    fireEvent.click(screen.getByRole("button", { name: "暂停同步" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("memory_vault_configure", {
        enabled: false,
        directory: null,
      }),
    );
    await screen.findByRole("button", { name: "恢复同步" });
  });
  it("opens the synchronized directory and preserves enabled state when switching folders", async () => {
    openMock.mockResolvedValue("/notes/obsidian");
    render(<MemoryVaultPanel />);
    expand();
    await screen.findByText("/notes/piko");
    fireEvent.click(screen.getByRole("button", { name: "打开文件夹" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("memory_vault_open_directory", {}),
    );
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "选择目录" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "选择目录" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("memory_vault_configure", {
        enabled: true,
        directory: "/notes/obsidian",
      }),
    );
  });
  it("requires an explicit comparison decision and sends the displayed version hashes", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "memory_vault_status")
        return { ...initial, report: { ...report, issues: [issue] } };
      if (command === "memory_vault_preview") return comparison;
      if (command === "memory_vault_resolve") return report;
      return {};
    });
    render(<MemoryVaultPanel />);
    expand();
    await screen.findByText("两侧均已修改");
    expect(
      invokeMock.mock.calls.some(
        ([command]) => command === "memory_vault_resolve",
      ),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "比较并处理" }));
    await screen.findByText("杭州");
    expect(screen.getByText("上海")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "使用 Markdown 版本" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("memory_vault_resolve", {
        input: {
          memoryId: "m1",
          path: issue.path,
          choice: "file",
          pikoVersion: "db-hash",
          fileVersion: "file-hash",
        },
      }),
    );
  });
  it("explains restoration pauses and disables synchronization on a temporary database", async () => {
    invokeMock.mockResolvedValue({
      ...initial,
      persistent: false,
      config: {
        ...initial.config,
        enabled: false,
        pausedReason: "数据库恢复后已暂停",
      },
    });
    render(<MemoryVaultPanel />);
    expand();
    await screen.findByText("数据库恢复后已暂停");
    expect(
      (screen.getByRole("button", { name: "恢复同步" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "立即同步" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
  it("shows stale-resolution errors without silently selecting a newer version", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "memory_vault_status")
        return { ...initial, report: { ...report, issues: [issue] } };
      if (command === "memory_vault_preview") return comparison;
      if (command === "memory_vault_resolve")
        throw new Error("两侧内容已变化，请重新打开比较后再选择");
      return {};
    });
    render(<MemoryVaultPanel />);
    expand();
    fireEvent.click(await screen.findByRole("button", { name: "比较并处理" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "保留 Piko 版本" }),
    );
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("两侧内容已变化");
  });
});
