// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { BubbleWindow } from "./BubbleWindow";
import type { ChatEvent } from "./chatTypes";
import type { AgentTaskSnapshot } from "./agentTypes";
import type { ChatHistoryEntry } from "../../types/appTypes";

const listenMock = vi.fn();
const runCommandMock = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock("../app/appRuntime", () => ({
  isTauriRuntime: true,
  runCommand: (...args: unknown[]) => runCommandMock(...args),
  runCommandQuiet: (...args: unknown[]) => runCommandMock(...args),
}));

const focusHandlers = new Set<(event: { payload: boolean }) => void>();
const setAlwaysOnTopMock = vi.fn(() => Promise.resolve());
const getCurrentWindowMock = vi.fn(() => ({
  setAlwaysOnTop: setAlwaysOnTopMock,
  startDragging: vi.fn(() => Promise.resolve()),
  innerSize: vi.fn(async () => ({ toLogical: () => ({ width: 480, height: 420 }) })),
  outerPosition: vi.fn(async () => ({ toLogical: () => ({ x: 0, y: 0 }) })),
  setPosition: vi.fn(async () => {}),
  scaleFactor: vi.fn(async () => 1),
  setDecorations: vi.fn(async () => {}),
  setSkipTaskbar: vi.fn(async () => {}),
  setSize: vi.fn(async () => {}),
  isFullscreen: vi.fn(async () => false),
  isMaximized: vi.fn(async () => false),
  onFocusChanged: vi.fn((handler: (event: { payload: boolean }) => void) => {
    focusHandlers.add(handler);
    return Promise.resolve<UnlistenFn>(() => { focusHandlers.delete(handler); });
  }),
  onDragDropEvent: vi.fn(() => Promise.resolve<UnlistenFn>(() => undefined)),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => getCurrentWindowMock(),
  currentMonitor: async () => ({ scaleFactor: 1, workArea: { position: { x: 0, y: 0 }, size: { width: 1440, height: 900 } } }),
  LogicalSize: class { constructor(public width: number, public height: number) {} },
  LogicalPosition: class { constructor(public x: number, public y: number) {} },
}));

vi.mock("../panel/PanelWindow", () => ({
  PanelWindow: ({ onClose }: { onClose: () => void }) => <section aria-label="主面板工作区"><button onClick={onClose}>返回聊天</button></section>,
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
let taskSnapshot: AgentTaskSnapshot | null | Promise<AgentTaskSnapshot | null> = null;

function installDefaultCommands() {
  runCommandMock.mockImplementation((command: string) => {
    if (command === "agent_get_task_snapshot") return Promise.resolve(taskSnapshot);
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
  const input = screen.getByLabelText("发送给 Piko 的问题") as HTMLTextAreaElement;
  await act(async () => {
    fireEvent.change(input, { target: { value: text } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
  });
}

describe("BubbleWindow 聊天事件流竞态", () => {
  it("opening and closing the workspace preserves the running stream and unsent input", async () => {
    render(<BubbleWindow />);
    await submitPrompt("继续生成");
    const requestId = chatStartInputCalls()[0].requestId;
    await act(async () => { emitChat({ type: "started", requestId, working: false }); });
    const input = screen.getByLabelText("发送给 Piko 的问题") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "补充草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "打开主面板" }));
    await screen.findByRole("button", { name: "返回聊天" });
    await act(async () => { emitChat({ type: "delta", requestId, sequence: 1, text: "回复继续到达" }); });
    fireEvent.click(screen.getByRole("button", { name: "返回聊天" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "打开主面板" })).toBeTruthy());
    expect(input.value).toBe("补充草稿");
    expect(await screen.findByText("回复继续到达")).toBeTruthy();
    expect(runCommandMock.mock.calls.filter(([command]) => command === "chat_cancel" || command === "agent_cancel")).toHaveLength(0);
  });
  async function showDesktopOpener() {
    await waitFor(() => expect(handlersByEvent.get("soul:message")?.size).toBe(1));
    await act(async () => {
      for (const handler of handlersByEvent.get("soul:message") ?? []) handler({ payload: {
        id: "desktop-flower-test", category: "desktop_observation", templateId: "desktop_observation",
        text: "第一朵花开了，要给它起个名字吗？", source: { kind: "desktop_observation", id: "desktop-flower-test", revision: 1 },
      } });
    });
    await screen.findByText("第一朵花开了，要给它起个名字吗？");
  }

  it("responding to a desktop opener forwards its identity only after the user sends a reply", async () => {
    render(<BubbleWindow />);
    await showDesktopOpener();
    expect(chatStartInputCalls()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "回应" }));
    expect(chatStartInputCalls()).toHaveLength(0);
    expect(runCommandMock).toHaveBeenCalledWith("soul_ack_message", { receipt: { message_id: "desktop-flower-test", kind: "responded", visible_seconds: 0 } });
    await submitPrompt("就叫小春吧");
    await waitFor(() => expect(chatStartInputCalls()).toHaveLength(1));
    const call = runCommandMock.mock.calls.find(([command]) => command === "agent_start");
    expect(call?.[1].input).toMatchObject({ prompt: "就叫小春吧", proactiveMessageId: "desktop-flower-test" });
  });

  it("a new conversation clears an unsent desktop-reply association", async () => {
    render(<BubbleWindow />);
    await showDesktopOpener();
    fireEvent.click(screen.getByRole("button", { name: "回应" }));
    fireEvent.click(screen.getByRole("button", { name: "新对话" }));
    await submitPrompt("另聊一个话题");
    await waitFor(() => expect(chatStartInputCalls()).toHaveLength(1));
    const call = runCommandMock.mock.calls.find(([command]) => command === "agent_start");
    expect(call?.[1].input.proactiveMessageId).toBeUndefined();
  });

  it("新对话清除草稿和截图，并等待后端清理后使用独立会话发送", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => key === "piko-unified-conversation-v1"
        ? JSON.stringify({ id: "old-conversation", cwd: "", importHistory: true, turnIds: ["old-request"] }) : null,
      setItem: vi.fn(),
    });
    const commands = runCommandMock.getMockImplementation()!;
    let finishClear!: () => void;
    const clearing = new Promise<void>(resolve => { finishClear = resolve; });
    runCommandMock.mockImplementation((command: string, ...args: unknown[]) => {
      if (command === "clear_text_attachment") return clearing;
      return commands(command, ...args);
    });
    render(<BubbleWindow />);
    await waitFor(() => expect(handlersByEvent.get("screenshot-ready")?.size).toBeGreaterThan(0));
    act(() => {
      for (const handler of handlersByEvent.get("screenshot-ready") ?? []) {
        handler({ payload: { dataUrl: "data:image/png;base64,test", width: 100, height: 100 } });
      }
    });
    fireEvent.change(screen.getByLabelText("发送给 Piko 的问题"), { target: { value: "旧草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "新对话" }));
    expect((screen.getByLabelText("发送给 Piko 的问题") as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByRole("button", { name: "移除截图" })).toBeNull();
    expect(runCommandMock).toHaveBeenCalledWith("clear_text_attachment");
    expect(runCommandMock).toHaveBeenCalledWith("clear_screen_capture");
    await submitPrompt("全新话题");
    expect(chatStartInputCalls()).toHaveLength(0);
    await act(async () => { finishClear(); await clearing; });
    await waitFor(() => expect(chatStartInputCalls()).toHaveLength(1));
    const input = runCommandMock.mock.calls.find(([command]) => command === "agent_start")?.[1].input;
    expect(input.conversationId).not.toBe("old-conversation");
    expect(input.importHistory).toBe(false);
    expect(input.includeScreenshot).toBe(false);
  });

  it("默认不置顶，点击图标切换原生窗口置顶并同步选中状态", async () => {
    render(<BubbleWindow />);
    const pin = screen.getByRole("button", { name: "窗口置顶" });
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    expect(setAlwaysOnTopMock).not.toHaveBeenCalled();
    fireEvent.click(pin);
    await waitFor(() => expect(pin.getAttribute("aria-pressed")).toBe("true"));
    expect(setAlwaysOnTopMock).toHaveBeenLastCalledWith(true);
    fireEvent.click(pin);
    await waitFor(() => expect(pin.getAttribute("aria-pressed")).toBe("false"));
    expect(setAlwaysOnTopMock).toHaveBeenLastCalledWith(false);
  });

  it("置顶失败时保持未选中，并允许重试", async () => {
    setAlwaysOnTopMock.mockRejectedValueOnce(new Error("window unavailable"));
    render(<BubbleWindow />);
    const pin = screen.getByRole("button", { name: "窗口置顶" });
    fireEvent.click(pin);
    await waitFor(() => expect((pin as HTMLButtonElement).disabled).toBe(false));
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(pin);
    await waitFor(() => expect(pin.getAttribute("aria-pressed")).toBe("true"));
  });

  beforeEach(() => {
    handlersByEvent.clear();
    focusHandlers.clear();
    setAlwaysOnTopMock.mockReset().mockResolvedValue(undefined);
    listenMock.mockReset();
    installListenMock();
    runCommandMock.mockReset();
    chatHistory = [];
    taskSnapshot = null;
    installDefaultCommands();
    uuidQueue = [];
    Object.defineProperty(cryptoTarget, "randomUUID", {
      configurable: true,
      writable: true,
      value: () => uuidQueue.shift() ?? "req-overflow",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup(); // vitest 未开启 globals，RTL 的 auto-cleanup 不会注册，需显式清理
    delete cryptoTarget.randomUUID;
    vi.restoreAllMocks();
  });

  it("Enter 发送多行内容，Shift+Enter 和中文输入法确认不发送", async () => {
    render(<BubbleWindow />);
    const input = await screen.findByLabelText("发送给 Piko 的问题");
    await waitFor(() => expect(listenMock).toHaveBeenCalled());
    fireEvent.change(input, { target: { value: "第一行\n第二行" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(chatStartInputCalls()).toHaveLength(0);
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(chatStartInputCalls()[0]?.prompt).toBe("第一行\n第二行");
  });

  it("上翻阅读时流式回复不抢滚动位置，点击最新消息后恢复跟随", async () => {
    queueUuids(["req-scroll"]);
    render(<BubbleWindow />);
    await waitFor(() => expect(historyRefreshCount()).toBe(1));
    await submitPrompt("一段长回答");
    act(() => {
      emitChat({ type: "started", requestId: "req-scroll", working: true });
      emitChat({ type: "delta", requestId: "req-scroll", sequence: 1, text: "第一段" });
    });
    const thread = screen.getByRole("region", { name: "对话内容" });
    Object.defineProperties(thread, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
    });
    thread.scrollTop = 250;
    fireEvent.scroll(thread);
    act(() => { emitChat({ type: "delta", requestId: "req-scroll", sequence: 2, text: "第二段" }); });
    expect(thread.scrollTop).toBe(250);
    fireEvent.click(screen.getByRole("button", { name: "回到最新消息" }));
    expect(thread.scrollTop).toBe(1000);
    expect(screen.queryByRole("button", { name: "回到最新消息" })).toBeNull();
  });

  it("窗口工具栏只保留业务操作，不重复原生窗口控制", async () => {
    render(<BubbleWindow />);
    await screen.findByLabelText("发送给 Piko 的问题");
    expect(screen.queryByRole("button", { name: "在完整窗口继续" })).toBeNull();
    expect(screen.queryByRole("button", { name: "返回快捷浮层" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^关闭$/ })).toBeNull();
    expect(screen.getByRole("button", { name: "新对话" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "窗口置顶" })).toBeTruthy();
  });

  it("Esc 先收起工作空间，再收起对话；展开时保留原有输入", async () => {
    render(<BubbleWindow />);
    const input = await screen.findByLabelText("发送给 Piko 的问题");
    fireEvent.change(input, { target: { value: "还没发送的灵感" } });
    const toggle = screen.getByRole("button", { name: "工作空间与收藏" });
    expect(screen.queryByRole("button", { name: /选择工作目录/ })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: /选择工作目录/ })).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(runCommandMock.mock.calls.some(([command]) => command === "hide_bubble")).toBe(false);
    expect((input as HTMLTextAreaElement).value).toBe("还没发送的灵感");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(runCommandMock).toHaveBeenCalledWith("hide_bubble");
  });

  it("恢复监听注册前的主动消息，保持来源且不启动任务", async () => {
    const defaultCommand = runCommandMock.getMockImplementation()!;
    const source = { kind: "agent_task", id: "task-interrupted", revision: 1 };
    runCommandMock.mockImplementation((command: string, ...args: unknown[]) => command === "soul_current_message"
      ? Promise.resolve({ id: "reserved-message", category: "task_unresolved", templateId: "task_interrupted", text: "恢复的任务提醒", source })
      : defaultCommand(command, ...args));
    render(<BubbleWindow />);
    expect(await screen.findByText("恢复的任务提醒")).toBeTruthy();
    await waitFor(() => expect(runCommandMock).toHaveBeenCalledWith("soul_ack_message", { receipt: { message_id: "reserved-message", kind: "shown", visible_seconds: 0 } }));
    expect(runCommandMock.mock.calls.some(([command]) => command === "agent_start")).toBe(false);
  });

  it("恢复读取期间已撤回的主动消息不会重新显示", async () => {
    const defaultCommand = runCommandMock.getMockImplementation()!;
    let recover!: (message: unknown) => void;
    runCommandMock.mockImplementation((command: string, ...args: unknown[]) => command === "soul_current_message"
      ? new Promise((resolve) => { recover = resolve; }) : defaultCommand(command, ...args));
    render(<BubbleWindow />);
    await waitFor(() => expect(recover).toBeTypeOf("function"));
    await act(async () => {
      for (const handler of handlersByEvent.get("soul:active") ?? []) handler({ payload: [] });
      recover({ id: "revoked-message", category: "task_unresolved", templateId: "task_interrupted", text: "已撤回的提醒", source: { kind: "agent_task", id: "task", revision: 1 } });
    });
    expect(screen.queryByText("已撤回的提醒")).toBeNull();
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


  it("routes concurrent replies, approvals and cancellation to their own conversation", async () => {
    queueUuids(["request-one", "request-two"]);
    const view = render(<>
      <div data-testid="session-one"><BubbleWindow tabId="conversation-one" /></div>
      <div data-testid="session-two"><BubbleWindow tabId="conversation-two" active={false} /></div>
    </>);
    await waitFor(() => expect(handlersByEvent.get("agent-event")?.size).toBe(2));
    const first = within(view.getByTestId("session-one"));
    const second = within(view.getByTestId("session-two"));
    for (const [surface, text] of [[first, "独立任务一"], [second, "独立任务二"]] as const) {
      const input = surface.getByLabelText("发送给 Piko 的问题");
      await act(async () => {
        fireEvent.change(input, { target: { value: text } });
        fireEvent.submit(input.closest("form")!);
      });
    }
    await waitFor(() => expect(chatStartInputCalls()).toHaveLength(2));
    const inputs = runCommandMock.mock.calls.filter(([command]) => command === "agent_start").map(call => call[1].input);
    expect(inputs.map(input => input.conversationId)).toEqual(["conversation-one", "conversation-two"]);
    expect(inputs.map(input => input.contextId)).toEqual(["conversation-one", "conversation-two"]);
    expect(inputs.every(input => input.importHistory === false)).toBe(true);
    await act(async () => {
      for (const handler of handlersByEvent.get("agent-event") ?? []) {
        handler({ payload: { type: "delta", requestId: "request-one", eventSequence: 1, text: "仅第一项回复" } });
        handler({ payload: { type: "delta", requestId: "request-two", eventSequence: 1, text: "仅第二项回复" } });
        handler({ payload: { type: "approval", requestId: "request-one", eventSequence: 2, approvalId: "approval-one", tool: "write", arguments: { path: "/one/result.txt" } } });
      }
    });
    expect(first.getByText("仅第一项回复")).toBeTruthy();
    expect(first.queryByText("仅第二项回复")).toBeNull();
    expect(await second.findByText("仅第二项回复")).toBeTruthy();
    expect(second.queryByRole("button", { name: "允许此次操作" })).toBeNull();
    fireEvent.click(first.getByRole("button", { name: "允许此次操作" }));
    await waitFor(() => expect(runCommandMock).toHaveBeenCalledWith("agent_approve", { requestId: "request-one", approvalId: "approval-one", allowed: true }));
    await act(async () => {
      for (const handler of handlersByEvent.get("agent-event") ?? []) handler({ payload: { type: "completed", requestId: "request-one", eventSequence: 3 } });
    });
    fireEvent.click(second.getByRole("button", { name: "停止生成" }));
    expect(runCommandMock).toHaveBeenCalledWith("agent_cancel", { requestId: "request-two" });
  });

  it("reopens a running task with partial text and approval without starting or cancelling execution", async () => {
    taskSnapshot = {
      requestId: "restored-task", conversationId: "restored-conversation", cwd: "/workspace",
      prompt: "检查工作目录", response: "已经读取文件", eventSequence: 4,
      events: [
        { type: "tool-start", requestId: "restored-task", toolCallId: "read", tool: "read" },
        { type: "tool-end", requestId: "restored-task", toolCallId: "read", output: "verified" },
        { type: "approval", requestId: "restored-task", approvalId: "approve", tool: "write", arguments: { path: "output.txt" } },
      ],
    };
    const view = render(<BubbleWindow />);
    await screen.findByText("已经读取文件");
    expect(screen.getByRole("button", { name: "允许此次操作" })).toBeTruthy();
    expect(chatStartInputCalls()).toHaveLength(0);
    await act(async () => {
      for (const handler of handlersByEvent.get("agent-event") ?? []) handler({ payload: {
        type: "approval-resolved", requestId: "restored-task", eventSequence: 5, approvalId: "approve", allowed: true,
      } });
    });
    expect(screen.queryByRole("button", { name: "允许此次操作" })).toBeNull();
    fireEvent.keyDown(screen.getByLabelText("发送给 Piko 的问题"), { key: "Escape" });
    expect(runCommandMock).toHaveBeenCalledWith("hide_bubble");
    view.unmount();
    await act(async () => {});
    expect(runCommandMock.mock.calls.filter((call) => call[0] === "agent_cancel")).toHaveLength(0);
    expect(handlersByEvent.get("agent-event")?.size).toBe(0);
    expect(handlersByEvent.get("chat-event")?.size).toBe(0);
  });

  it("merges a snapshot and buffered live text without repeating the overlapping delta", async () => {
    let resolve!: (snapshot: AgentTaskSnapshot) => void;
    taskSnapshot = new Promise((done) => { resolve = done; });
    render(<BubbleWindow />);
    await waitFor(() => expect(runCommandMock).toHaveBeenCalledWith("agent_get_task_snapshot", undefined, null));
    await act(async () => {
      for (const handler of handlersByEvent.get("agent-event") ?? []) {
        handler({ payload: { type: "delta", requestId: "buffered-task", eventSequence: 2, text: "前半段" } });
        handler({ payload: { type: "delta", requestId: "buffered-task", eventSequence: 3, text: "后半段" } });
      }
      resolve({ requestId: "buffered-task", conversationId: "buffered-conversation", cwd: null,
        prompt: "继续", response: "前半段", eventSequence: 2, events: [] });
    });
    await screen.findByText("前半段后半段");
    expect(screen.queryByText("前半段前半段后半段")).toBeNull();
    expect(chatStartInputCalls()).toHaveLength(0);
    await act(async () => {
      for (const handler of handlersByEvent.get("agent-event") ?? []) handler({ payload: {
        type: "completed", requestId: "buffered-task", eventSequence: 4,
      } });
    });
    await waitFor(() => expect(screen.queryByTitle("停止生成")).toBeNull());
  });

  it("shows history read errors and retries without presenting an empty welcome state", async () => {
    const defaults = runCommandMock.getMockImplementation()!;
    let fail = true;
    runCommandMock.mockImplementation((command: string) => {
      if (command === "conversation_chat_history") {
        if (fail) return Promise.reject(new Error("历史文件读取失败"));
        return Promise.resolve([{ id: "saved-history", prompt: "之前的问题", response: "之前的回答", createdAt: 1 }]);
      }
      return defaults(command);
    });
    render(<BubbleWindow tabId="history-error-test" />);
    await screen.findByText("历史文件读取失败");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "重试加载历史" }));
    fireEvent.click(await screen.findByRole("button", { name: /之前的问题/ }));
    await screen.findByText("之前的回答");
    expect(screen.queryByText("历史文件读取失败")).toBeNull();
  });

});
