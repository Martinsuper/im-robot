// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { BubbleWindow } from "./BubbleWindow";
import type { ChatEvent } from "./chatTypes";
import type { ChatHistoryEntry } from "../../types/appTypes";

const listenMock = vi.fn();
const runCommandMock = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock("../app/appRuntime", () => ({
  isTauriRuntime: true,
  runCommand: (...args: unknown[]) => runCommandMock(...args),
  runCommandQuiet: (...args: unknown[]) => runCommandMock(...args),
}));

const focusHandlers = new Set<(event: { payload: boolean }) => void>();
const getCurrentWindowMock = vi.fn(() => ({
  startDragging: vi.fn(() => Promise.resolve()),
  onFocusChanged: vi.fn((handler: (event: { payload: boolean }) => void) => {
    focusHandlers.add(handler);
    return Promise.resolve<UnlistenFn>(() => { focusHandlers.delete(handler); });
  }),
  onDragDropEvent: vi.fn(() => Promise.resolve<UnlistenFn>(() => undefined)),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => getCurrentWindowMock(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(() => Promise.resolve(true)),
  requestPermission: vi.fn(() => Promise.resolve("granted")),
}));

vi.mock("../i18n/I18nProvider", () => {
  const t = (key: string, fallback?: string) => fallback ?? key;
  return {
    useTranslation: () => ({ locale: "zh-CN", t, setLocale: () => undefined }),
  };
});

vi.mock("../app/appShared", () => ({
  PetSprite: ({ mode }: { mode?: string }) => (
    <span data-testid="pet-sprite" data-mode={mode ?? "idle"} />
  ),
  attachmentActionOptions: [{ label: "总结", labelKey: "chat.attachment.summarize", value: "summarize" }],
  defaultAppSettings: {
    quietMode: "balanced",
    companionName: "Piko",
    theme: "sage",
    language: "zh-CN",
    htmlPreviewEnabled: false,
    hasApiKey: false,
    ai: { baseUrl: "http://localhost:11434/v1" },
  },
  formatBytes: (bytes: number) => `${bytes} B`,
}));

// --- 事件注册表：按事件名收集 handler，测试手动派发 ---

type Handler = (event: { payload: unknown }) => void;
const handlersByEvent = new Map<string, Set<Handler>>();

function installListenMock() {
  listenMock.mockImplementation((eventName: string, handler: Handler) => {
    let handlers = handlersByEvent.get(eventName);
    if (!handlers) {
      handlers = new Set<Handler>();
      handlersByEvent.set(eventName, handlers);
    }
    handlers.add(handler);
    const unlisten: UnlistenFn = () => {
      handlers?.delete(handler);
    };
    return Promise.resolve(unlisten);
  });
}

function emitChat(payload: ChatEvent) {
  for (const handler of handlersByEvent.get("chat-event") ?? []) {
    handler({ payload });
  }
}

// --- 命令 mock：chat_start 挂起模拟进行中的请求 ---

let chatHistory: ChatHistoryEntry[];

function installDefaultCommands() {
  runCommandMock.mockImplementation((command: string) => {
    if (command === "get_settings") {
      return Promise.resolve({
        companionName: "Piko",
        theme: "sage",
        htmlPreviewEnabled: false,
        language: "zh-CN",
        hasApiKey: false,
        ai: { baseUrl: "http://localhost:11434/v1" },
      });
    }
    if (command === "get_bubble_chat_history") {
      return Promise.resolve(chatHistory);
    }
    if (command === "list_html_favorites") {
      return Promise.resolve([]);
    }
    if (command === "agent_start") {
      return new Promise<void>(() => undefined); // 挂起不 resolve
    }
    return Promise.resolve(undefined);
  });
}

function historyRefreshCount(): number {
  return runCommandMock.mock.calls.filter((call) => call[0] === "get_bubble_chat_history").length;
}

function chatStartInputCalls(): Array<{ requestId: string; prompt: string }> {
  return runCommandMock.mock.calls
    .filter((call) => call[0] === "agent_start")
    .map((call) => {
      const input = (call[1] as { input: { requestId: string; prompt: string } }).input;
      return { requestId: String(input.requestId), prompt: String(input.prompt) };
    });
}

// --- crypto.randomUUID 桩：按队列返回固定请求 ID ---

let uuidQueue: string[];
const cryptoTarget = globalThis.crypto as unknown as Record<string, unknown>;

function queueUuids(ids: string[]) {
  uuidQueue.push(...ids);
}

// --- 渲染与输入工具 ---

async function submitPrompt(text: string) {
  const input = screen.getByLabelText("发送给 Piko 的问题") as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { value: text } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
  });
}

describe("BubbleWindow 聊天事件流竞态", () => {
  beforeEach(() => {
    handlersByEvent.clear();
    focusHandlers.clear();
    listenMock.mockReset();
    installListenMock();
    runCommandMock.mockReset();
    chatHistory = [];
    installDefaultCommands();
    uuidQueue = [];
    Object.defineProperty(cryptoTarget, "randomUUID", {
      configurable: true,
      writable: true,
      value: () => uuidQueue.shift() ?? "req-overflow",
    });
  });

  afterEach(() => {
    cleanup(); // vitest 未开启 globals，RTL 的 auto-cleanup 不会注册，需显式清理
    delete cryptoTarget.randomUUID;
    vi.restoreAllMocks();
  });

  it("执行中禁止重复发送，完成后新请求忽略旧请求事件", async () => {
    queueUuids(["req-a", "req-b"]);
    render(<BubbleWindow />);
    await waitFor(() => expect(historyRefreshCount()).toBe(1));
    await submitPrompt("查一下天气");
    await submitPrompt("帮我写周报");
    expect(chatStartInputCalls()).toEqual([{ requestId: "req-a", prompt: "查一下天气" }]);
    act(() => emitChat({ type: "completed", requestId: "req-a" }));
    await submitPrompt("帮我写周报");
    expect(chatStartInputCalls()).toHaveLength(2);
    act(() => {
      emitChat({ type: "delta", requestId: "req-a", sequence: 1, text: "旧请求回答" });
      emitChat({ type: "started", requestId: "req-b", working: false });
      emitChat({ type: "delta", requestId: "req-b", sequence: 1, text: "新的回复" });
    });
    expect(screen.queryByText("旧请求回答")).toBeNull();
    expect(await screen.findByText("新的回复")).toBeTruthy();
  });

  it("同一请求内：乱序与重复 sequence 的 delta 被去重", async () => {
    queueUuids(["req-seq"]);
    render(<BubbleWindow />);
    await waitFor(() => expect(historyRefreshCount()).toBe(1));

    await submitPrompt("讲个故事");
    act(() => {
      emitChat({ type: "started", requestId: "req-seq", working: true });
      emitChat({ type: "delta", requestId: "req-seq", sequence: 2, text: "乙" });
      emitChat({ type: "delta", requestId: "req-seq", sequence: 1, text: "甲" }); // 旧序号被忽略
      emitChat({ type: "delta", requestId: "req-seq", sequence: 2, text: "重复" }); // 重复序号被忽略
      emitChat({ type: "delta", requestId: "req-seq", sequence: 3, text: "丙" });
    });

    await screen.findByText("乙丙");
    expect(screen.queryByText(/甲/)).toBeNull();
  });

  it("started 事件清空旧消息、重置去重序号并重新显示骨架", async () => {
    queueUuids(["req-r"]);
    render(<BubbleWindow />);
    await waitFor(() => expect(historyRefreshCount()).toBe(1));

    await submitPrompt("再来一次");
    act(() => {
      emitChat({ type: "started", requestId: "req-r", working: true });
      emitChat({ type: "delta", requestId: "req-r", sequence: 1, text: "第一版回答" });
      emitChat({ type: "completed", requestId: "req-r" });
    });
    await screen.findByText("第一版回答");

    // 同 requestId 重新 started（后端重试场景）：消息清空、lastSequence 归零
    act(() => {
      emitChat({ type: "started", requestId: "req-r", working: true });
      emitChat({ type: "delta", requestId: "req-r", sequence: 1, text: "第二版回答" });
    });
    await screen.findByText("第二版回答");
    expect(screen.queryByText("第一版回答")).toBeNull();
  });

  it("failed 事件展示失败信息并结束生成状态", async () => {
    queueUuids(["req-f"]);
    render(<BubbleWindow />);
    await waitFor(() => expect(historyRefreshCount()).toBe(1));

    await submitPrompt("会失败的问题");
    act(() => {
      emitChat({ type: "started", requestId: "req-f", working: true });
      emitChat({ type: "failed", requestId: "req-f", message: "模型服务超时" });
    });

    expect(screen.getByText("模型服务超时")).toBeTruthy();
    expect(screen.queryByText("正在生成回复")).toBeNull();
  });

  it("cancelled 事件保留已生成内容并触发历史刷新", async () => {
    queueUuids(["req-c"]);
    render(<BubbleWindow />);
    await waitFor(() => expect(historyRefreshCount()).toBe(1));

    await submitPrompt("被取消的问题");
    act(() => {
      emitChat({ type: "started", requestId: "req-c", working: true });
      emitChat({ type: "delta", requestId: "req-c", sequence: 1, text: "部分内容" });
    });
    act(() => {
      emitChat({ type: "cancelled", requestId: "req-c" });
    });

    expect(screen.getByText("部分内容")).toBeTruthy(); // 已有内容优先于"已停止"提示
    await waitFor(() => expect(historyRefreshCount()).toBe(2));
    expect(screen.queryByText("正在生成回复")).toBeNull();
  });

  it("未知 requestId 的事件在无活跃请求时被完全忽略", async () => {
    queueUuids(["req-unused"]);
    render(<BubbleWindow />);
    await waitFor(() => expect(historyRefreshCount()).toBe(1));
    expect(screen.getByText(/你好，我是 Piko/)).toBeTruthy(); // 欢迎态

    act(() => {
      emitChat({ type: "delta", requestId: "req-ghost", sequence: 1, text: "幽灵消息" });
      emitChat({ type: "completed", requestId: "req-ghost" });
    });

    expect(screen.queryByText("幽灵消息")).toBeNull();
    expect(historyRefreshCount()).toBe(1);
  });

  it("action-proposed 事件渲染操作确认卡片并结束骨架", async () => {
    queueUuids(["req-act"]);
    render(<BubbleWindow />);
    await waitFor(() => expect(historyRefreshCount()).toBe(1));

    await submitPrompt("帮我创建提醒");
    act(() => {
      emitChat({ type: "started", requestId: "req-act", working: true });
      emitChat({
        type: "action-proposed",
        requestId: "req-act",
        draft: {
          id: "draft-1",
          pluginId: "piko.reminders",
          toolName: "create_reminder",
          summary: "创建提醒：明天 9 点开会",
          arguments: {},
          createdAt: 0,
        },
      });
    });

    expect(screen.getByText("创建提醒：明天 9 点开会")).toBeTruthy();
    expect(screen.getByText("待确认操作")).toBeTruthy();
    expect(screen.queryByText("正在生成回复")).toBeNull();
  });

  it("确认成功保留实际执行结果，不再发起可能重复写入的模型请求", async () => {
    queueUuids(["req-confirm"]);
    runCommandMock.mockImplementation((command: string) => {
      if (command === "get_settings") return Promise.resolve({
        companionName: "Piko", theme: "sage", htmlPreviewEnabled: false,
        language: "zh-CN", hasApiKey: true, ai: { baseUrl: "http://127.0.0.1:8317/v1" },
      });
      if (command === "get_bubble_chat_history") return Promise.resolve([]);
      if (command === "list_html_favorites") return Promise.resolve([]);
      if (command === "confirm_chat_action") return Promise.resolve({
        message: "日程已创建。", followUpPrompt: "系统已经执行，请确认结果。", result: {},
      });
      return Promise.resolve(undefined);
    });
    render(<BubbleWindow />);
    await waitFor(() => expect(historyRefreshCount()).toBe(1));
    await submitPrompt("创建明早起床日程");
    act(() => emitChat({ type: "action-proposed", requestId: "req-confirm", draft: {
      id: "draft-calendar", pluginId: "piko.calendar", toolName: "create_event",
      summary: "创建起床日程", arguments: {}, createdAt: 0,
    } }));
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    await screen.findByText("日程已创建。");
    expect(chatStartInputCalls()).toHaveLength(1);
    expect(runCommandMock.mock.calls.filter(call => call[0] === "confirm_chat_action")).toHaveLength(1);
    expect(screen.queryByText("待确认操作")).toBeNull();
    expect(screen.queryByText("正在生成回复")).toBeNull();
    act(() => emitChat({ type: "failed", requestId: "req-confirm", message: "迟到的错误" }));
    expect(screen.getByText("日程已创建。")).toBeTruthy();
    expect(screen.queryByText("迟到的错误")).toBeNull();
  });

  it.each(["create_event_batch", "delete_event_batch"])("%s 只提交勾选的日程且直接显示执行结果", async (toolName) => {
    queueUuids(["req-batch"]);
    const defaultCommands = runCommandMock.getMockImplementation()!;
    runCommandMock.mockImplementation((command: string, ...args: unknown[]) => {
      if (command === "confirm_chat_action") return Promise.resolve({
        message: "所选日程执行成功。", result: {},
      });
      return defaultCommands(command, ...args);
    });
    render(<BubbleWindow />);
    await waitFor(() => expect(historyRefreshCount()).toBe(1));
    await submitPrompt("处理测试日程");
    act(() => emitChat({ type: "action-proposed", requestId: "req-batch", draft: {
      id: "draft-batch", pluginId: "piko.calendar", toolName, summary: "批量操作两条测试日程",
      arguments: { events: [{ id: "a", title: "测试 A" }, { id: "b", title: "测试 B" }] }, createdAt: 0,
    } }));
    fireEvent.click(screen.getByRole("checkbox", { name: "测试 A" }));
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    await screen.findByText("所选日程执行成功。");
    expect(runCommandMock).toHaveBeenCalledWith("confirm_chat_action", {
      id: "draft-batch", selectedIndexes: [1],
    });
    expect(chatStartInputCalls()).toHaveLength(1);
    expect(screen.queryByText("待确认操作")).toBeNull();
  });

  it("批量删除取消全部勾选后禁止确认，取消草稿不执行删除", async () => {
    queueUuids(["req-cancel-batch"]);
    render(<BubbleWindow />);
    await waitFor(() => expect(historyRefreshCount()).toBe(1));
    await submitPrompt("删除测试日程");
    act(() => emitChat({ type: "action-proposed", requestId: "req-cancel-batch", draft: {
      id: "draft-cancel-batch", pluginId: "piko.calendar", toolName: "delete_event_batch",
      summary: "删除测试日程", arguments: { events: [{ id: "a", title: "测试 A" }] }, createdAt: 0,
    } }));
    fireEvent.click(screen.getByRole("checkbox", { name: "测试 A" }));
    expect((screen.getByRole("button", { name: "确认执行" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await screen.findByText("已取消该操作。");
    expect(runCommandMock).toHaveBeenCalledWith("reject_chat_action", { id: "draft-cancel-batch" });
    expect(runCommandMock.mock.calls.filter(call => call[0] === "confirm_chat_action")).toHaveLength(0);
    expect(chatStartInputCalls()).toHaveLength(1);
  });

  it("批量删除执行失败不显示成功、不发起第二次模型请求", async () => {
    queueUuids(["req-failed-batch"]);
    const defaultCommands = runCommandMock.getMockImplementation()!;
    runCommandMock.mockImplementation((command: string, ...args: unknown[]) => {
      if (command === "confirm_chat_action") return Promise.reject(new Error("待删除日程不存在"));
      return defaultCommands(command, ...args);
    });
    render(<BubbleWindow />);
    await waitFor(() => expect(historyRefreshCount()).toBe(1));
    await submitPrompt("删除测试日程");
    act(() => emitChat({ type: "action-proposed", requestId: "req-failed-batch", draft: {
      id: "draft-failed-batch", pluginId: "piko.calendar", toolName: "delete_event_batch",
      summary: "删除测试日程", arguments: { events: [{ id: "a", title: "测试 A" }] }, createdAt: 0,
    } }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "确认执行" })));
    expect(screen.getByRole("button", { name: "确认执行" })).toBeTruthy();
    expect(screen.queryByText("日程已删除。")).toBeNull();
    expect(chatStartInputCalls()).toHaveLength(1);
    expect(runCommandMock.mock.calls.filter(call => call[0] === "confirm_chat_action")).toHaveLength(1);
  });

  it("chat_start 被拒绝时隐藏骨架并展示连接失败消息", async () => {
    queueUuids(["req-err"]);
    runCommandMock.mockImplementation((command: string) => {
      if (command === "get_settings") {
        return Promise.resolve({
          companionName: "Piko",
          theme: "sage",
          htmlPreviewEnabled: false,
          language: "zh-CN",
          hasApiKey: false,
          ai: { baseUrl: "http://localhost:11434/v1" },
        });
      }
      if (command === "get_bubble_chat_history") {
        return Promise.resolve([] as ChatHistoryEntry[]);
      }
      if (command === "list_html_favorites") {
        return Promise.resolve([]);
      }
      if (command === "agent_start") {
        return Promise.reject(new Error("backend down"));
      }
      return Promise.resolve(undefined);
    });

    render(<BubbleWindow />);
    await waitFor(() => expect(historyRefreshCount()).toBe(1));

    await submitPrompt("触发失败");
    // catch 分支执行了 setIsThinking(false)：停止按钮被发送按钮替换
    await waitFor(() => expect(screen.queryByTitle("停止生成")).toBeNull());
    // 骨架隐藏、错误消息可见（chat_start .catch 完整复位生成态）
    expect(screen.queryByText("正在生成回复")).toBeNull();
    expect(screen.getByText(/网络好像不太稳定/)).toBeTruthy();
  });
  it("does not steal focus from a detached window when chat loses focus", async () => {
    render(<><button type="button">Detached window</button><BubbleWindow /></>);
    await waitFor(() => expect(historyRefreshCount()).toBe(1));
    const otherWindow = screen.getByRole("button", { name: "Detached window" });
    otherWindow.focus();
    await act(async () => {
      for (const handler of focusHandlers) handler({ payload: true });
      for (const handler of focusHandlers) handler({ payload: false });
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    });
    expect(document.activeElement).toBe(otherWindow);
    await act(async () => {
      for (const handler of focusHandlers) handler({ payload: false });
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    });
    expect(document.activeElement).toBe(otherWindow);
  });

});
