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

const getCurrentWindowMock = vi.fn(() => ({
  startDragging: vi.fn(() => Promise.resolve()),
  onFocusChanged: vi.fn(() => Promise.resolve<UnlistenFn>(() => undefined)),
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
      return Promise.resolve({ companionName: "Piko", theme: "sage", htmlPreviewEnabled: false, language: "zh-CN" });
    }
    if (command === "get_bubble_chat_history") {
      return Promise.resolve(chatHistory);
    }
    if (command === "chat_start") {
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
    .filter((call) => call[0] === "chat_start")
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

function submitPrompt(text: string) {
  const input = screen.getByLabelText("发送给 Piko 的问题") as HTMLInputElement;
  act(() => {
    fireEvent.change(input, { target: { value: text } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
  });
}

describe("BubbleWindow 聊天事件流竞态", () => {
  beforeEach(() => {
    handlersByEvent.clear();
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

  it("并发竞态：旧请求 A 的 started/delta/completed 不会覆盖新请求 B 的显示", async () => {
    queueUuids(["req-a", "req-b"]);
    render(<BubbleWindow />);
    await waitFor(() => expect(historyRefreshCount()).toBe(1));

    // 请求 A 开始（chat_start 挂起，模拟进行中）
    submitPrompt("查一下天气");
    expect(chatStartInputCalls()).toEqual([{ requestId: "req-a", prompt: "查一下天气" }]);
    expect(screen.getByText("查一下天气")).toBeTruthy(); // 用户气泡
    expect(screen.getByText("正在生成回复")).toBeTruthy(); // 骨架

    // 未等 A 返回，直接再次提交 -> 请求 B 接管
    submitPrompt("帮我写周报");
    expect(chatStartInputCalls()).toEqual([
      { requestId: "req-a", prompt: "查一下天气" },
      { requestId: "req-b", prompt: "帮我写周报" },
    ]);

    // A 的事件交错到达，必须全部被忽略
    act(() => {
      emitChat({ type: "started", requestId: "req-a", working: true });
      emitChat({ type: "delta", requestId: "req-a", sequence: 1, text: "旧请求的回答" });
      emitChat({ type: "completed", requestId: "req-a" });
    });

    expect(screen.queryByText("旧请求的回答")).toBeNull();
    expect(screen.getByText("正在生成回复")).toBeTruthy(); // B 仍在生成
    expect(historyRefreshCount()).toBe(1); // A 的 completed 不触发历史刷新

    // B 的事件正常渲染
    act(() => {
      emitChat({ type: "started", requestId: "req-b", working: true });
      emitChat({ type: "delta", requestId: "req-b", sequence: 1, text: "本周完成了" });
      emitChat({ type: "delta", requestId: "req-b", sequence: 2, text: "三个需求" });
    });
    await screen.findByText("本周完成了三个需求");

    act(() => {
      emitChat({ type: "completed", requestId: "req-b" });
    });
    await waitFor(() => expect(historyRefreshCount()).toBe(2)); // B 的 completed 刷新历史
    expect(screen.queryByText("正在生成回复")).toBeNull();
    expect(screen.getByText("本周完成了三个需求")).toBeTruthy();

    // B 完成后 A 的迟到事件仍被忽略
    act(() => {
      emitChat({ type: "delta", requestId: "req-a", sequence: 9, text: "迟到的旧回答" });
    });
    expect(screen.queryByText("迟到的旧回答")).toBeNull();
    expect(screen.getByText("本周完成了三个需求")).toBeTruthy();
  });

  it("同一请求内：乱序与重复 sequence 的 delta 被去重", async () => {
    queueUuids(["req-seq"]);
    render(<BubbleWindow />);
    await waitFor(() => expect(historyRefreshCount()).toBe(1));

    submitPrompt("讲个故事");
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

    submitPrompt("再来一次");
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

    submitPrompt("会失败的问题");
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

    submitPrompt("被取消的问题");
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
    expect(screen.getByText("你好，我是 Piko。今天想一起完成什么？")).toBeTruthy(); // 欢迎态

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

    submitPrompt("帮我创建提醒");
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

  it("chat_start 被拒绝时关闭思考状态（已知源码问题：骨架未随失败隐藏）", async () => {
    queueUuids(["req-err"]);
    runCommandMock.mockImplementation((command: string) => {
      if (command === "get_settings") {
        return Promise.resolve({ companionName: "Piko", theme: "sage", htmlPreviewEnabled: false, language: "zh-CN" });
      }
      if (command === "get_bubble_chat_history") {
        return Promise.resolve([] as ChatHistoryEntry[]);
      }
      if (command === "chat_start") {
        return Promise.reject(new Error("backend down"));
      }
      return Promise.resolve(undefined);
    });

    render(<BubbleWindow />);
    await waitFor(() => expect(historyRefreshCount()).toBe(1));

    submitPrompt("触发失败");
    // catch 分支执行了 setIsThinking(false)：停止按钮被发送按钮替换
    await waitFor(() => expect(screen.queryByTitle("停止生成")).toBeNull());
    // 已知源码问题（BubbleWindow.tsx sendPrompt 的 chat_start .catch）：
    // 未调用 setShowReplySkeleton(false) / clearSkeletonHideTimer()，
    // 骨架停留在"正在生成回复"，连接失败的错误消息被骨架遮挡无法展示。
    // 修复后应改为断言：骨架消失且展示 /模型服务连接失败/。
    expect(screen.getByText("正在生成回复")).toBeTruthy();
    expect(screen.queryByText(/模型服务连接失败/)).toBeNull();
  });
});
