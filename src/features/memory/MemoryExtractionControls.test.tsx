// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryExtractionControls } from "./MemoryExtractionControls";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
vi.mock("../app/appRuntime", () => ({ isTauriRuntime: true }));
vi.mock("../i18n/I18nProvider", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));
const initial = {
  enabled: true,
  intervalMinutes: 30,
  lastRunAt: 0,
  processedCount: 0,
  pendingCount: 0,
};

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset().mockResolvedValue(() => {});
  invokeMock.mockImplementation(
    async (
      command: string,
      args?: { enabled: boolean; intervalMinutes: number },
    ) => {
      if (command === "configure_memory_extraction")
        return { ...initial, ...args };
      if (command === "extract_memories_now") return 2;
      return initial;
    },
  );
});
afterEach(cleanup);

describe("memory extraction controls", () => {
  it("loads persisted settings, pauses extraction, and changes its interval", async () => {
    render(<MemoryExtractionControls />);
    fireEvent.click(screen.getByText("自动提取设置"));
    const toggle = screen.getByRole("checkbox");
    await waitFor(() =>
      expect((toggle as HTMLInputElement).checked).toBe(true),
    );
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("configure_memory_extraction", {
        enabled: false,
        intervalMinutes: 30,
      }),
    );
    await waitFor(() =>
      expect((toggle as HTMLInputElement).disabled).toBe(false),
    );
    fireEvent.change(screen.getByLabelText("提取间隔"), {
      target: { value: "60" },
    });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("configure_memory_extraction", {
        enabled: false,
        intervalMinutes: 60,
      }),
    );
  });

  it("runs extraction, refreshes status, and directs the user to pending candidates", async () => {
    render(<MemoryExtractionControls />);
    const button = screen.getByRole("button", { name: "立即提取" });
    await waitFor(() =>
      expect((button as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "新增 2 条候选记忆",
      ),
    );
    expect(invokeMock).toHaveBeenCalledWith("extract_memories_now", {});
    expect(
      invokeMock.mock.calls.filter(
        ([command]) => command === "get_memory_extraction_status",
      ),
    ).toHaveLength(2);
  });

  it("shows failures and re-enables controls so extraction can be retried", async () => {
    render(<MemoryExtractionControls />);
    const button = screen.getByRole("button", { name: "立即提取" });
    await waitFor(() =>
      expect((button as HTMLButtonElement).disabled).toBe(false),
    );
    invokeMock.mockRejectedValueOnce(new Error("数据库暂时不可用"));
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "数据库暂时不可用",
      ),
    );
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
