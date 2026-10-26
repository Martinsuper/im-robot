// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationTabs } from "./ConversationTabs";

const { command, handlers } = vi.hoisted(() => ({
  command: vi.fn(), handlers: new Map<string, Set<(event: { payload: unknown }) => void>>(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    const listeners = handlers.get(name) ?? new Set();
    listeners.add(handler); handlers.set(name, listeners);
    return () => listeners.delete(handler);
  }),
}));
vi.mock("../app/appRuntime", () => ({ isTauriRuntime: true, runCommand: command }));
vi.mock("../app/settingsStore", () => ({ useAppSettings: () => ({ settings: { theme: "sage", companionName: "Piko" } }) }));
vi.mock("./BubbleWindow", () => ({ BubbleWindow: ({ tabId }: { tabId: string }) => <section data-testid="chat">{tabId}</section> }));
vi.mock("./conversationWindows", () => ({
  openConversationWindow: vi.fn(), closeConversationWindow: vi.fn(), previewWindows: () => ({ revision: 0, windows: [] }), PREVIEW_WINDOWS_KEY: "windows",
}));
const id = (index: number) => `passport-${index.toString(16).padStart(24, "0")}`;
const history = Array.from({ length: 40 }, (_, index) => ({
  id: `turn-${index}`, conversationId: id(index), prompt: `设备问题 ${index}`, response: "回答", createdAt: index,
}));
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  handlers.clear(); command.mockReset();
  localStorage.setItem("piko.conversation.tabs.v1", JSON.stringify({ tabs: [{ id: "desktop", title: "电脑对话" }], selected: "desktop" }));
  command.mockImplementation(async (name: string) => {
    if (name === "conversation_list_windows") return { revision: 0, windows: [] };
    if (name === "list_chat_history") return history;
    return [];
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("paginates device history without mounting historical chat windows", async () => {
  render(<ConversationTabs />);
  await screen.findByRole("button", { name: "设备问题 39" });
  expect(screen.getAllByTestId("chat")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "设备问题 0" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "显示更多对话" }));
  expect(screen.getByRole("button", { name: "设备问题 0" })).toBeTruthy();
  expect(screen.getAllByTestId("chat")).toHaveLength(1);
});

it("confirms deletion and removes the saved conversation before closing its tab", async () => {
  const mounted = render(<ConversationTabs />);
  fireEvent.click(await screen.findByRole("button", { name: "设备问题 39" }));
  fireEvent.click(screen.getByRole("button", { name: "删除会话：设备问题 39" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  const confirmation = screen.getByRole("button", { name: "确认删除会话：设备问题 39" });
  expect(confirmation.textContent).toBe("");
  expect(confirmation.querySelector("svg.lucide-trash-2")).toBeTruthy();
  expect(command).not.toHaveBeenCalledWith("conversation_delete", expect.anything());
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.getByRole("button", { name: "删除会话：设备问题 39" })).toBeTruthy();
  expect(screen.getAllByTestId("chat")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "删除会话：设备问题 39" }));
  command.mockImplementation(async (name: string) => {
    if (name === "conversation_list_windows") return { revision: 0, windows: [] };
    if (name === "list_chat_history") return history.filter(entry => entry.conversationId !== id(39));
    return [];
  });
  fireEvent.click(screen.getByRole("button", { name: "确认删除会话：设备问题 39" }));
  await waitFor(() => expect(screen.getAllByTestId("chat")).toHaveLength(1));
  expect(command).toHaveBeenCalledWith("conversation_delete", { conversationId: id(39) });
  mounted.unmount(); render(<ConversationTabs />);
  await screen.findByRole("button", { name: "设备问题 38" });
  expect(screen.queryByRole("button", { name: "设备问题 39" })).toBeNull();
});

it("keeps the conversation and inline confirmation when deletion fails", async () => {
  render(<ConversationTabs />);
  fireEvent.click(await screen.findByRole("button", { name: "设备问题 39" }));
  command.mockRejectedValueOnce(new Error("写入失败"));
  fireEvent.click(screen.getByRole("button", { name: "删除会话：设备问题 39" }));
  fireEvent.click(screen.getByRole("button", { name: "确认删除会话：设备问题 39" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "确认删除会话：设备问题 39" }).hasAttribute("disabled")).toBe(false));
  expect(screen.queryByRole("dialog")).toBeNull();
  const confirmation = screen.getByRole("button", { name: "确认删除会话：设备问题 39" });
  expect(confirmation.textContent).toBe("");
  expect(confirmation.querySelector("svg.lucide-trash-2")).toBeTruthy();
  expect(screen.getAllByTestId("chat")).toHaveLength(2);
});

it("can delete a closed conversation from device history", async () => {
  render(<ConversationTabs />);
  fireEvent.click(await screen.findByRole("button", { name: "删除会话：设备问题 39" }));
  fireEvent.click(screen.getByRole("button", { name: "确认删除会话：设备问题 39" }));
  await waitFor(() => expect(command).toHaveBeenCalledWith("conversation_delete", { conversationId: id(39) }));
});

it("cancels inline confirmation outside the button and only arms one conversation", async () => {
  render(<ConversationTabs />);
  fireEvent.click(await screen.findByRole("button", { name: "删除会话：设备问题 39" }));
  fireEvent.pointerDown(screen.getByRole("tab", { name: "电脑对话" }));
  expect(screen.queryByRole("button", { name: "确认删除会话：设备问题 39" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "删除会话：设备问题 39" }));
  fireEvent.click(screen.getByRole("button", { name: "删除会话：设备问题 38" }));
  expect(screen.getByRole("button", { name: "删除会话：设备问题 39" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "确认删除会话：设备问题 38" })).toBeTruthy();
  fireEvent.focusIn(screen.getByRole("tab", { name: "电脑对话" }));
  expect(screen.queryByRole("button", { name: "确认删除会话：设备问题 38" })).toBeNull();
  expect(command).not.toHaveBeenCalledWith("conversation_delete", expect.anything());
});

it("does not exceed twelve open conversations when opening saved or live device chats", async () => {
  const tabs = Array.from({ length: 12 }, (_, index) => ({ id: `desktop-${index}`, title: `电脑 ${index}` }));
  localStorage.setItem("piko.conversation.tabs.v1", JSON.stringify({ tabs, selected: tabs[0].id }));
  render(<ConversationTabs />);
  fireEvent.click(await screen.findByRole("button", { name: "设备问题 39" }));
  await act(async () => {
    for (const listener of handlers.get("agent-event") ?? []) listener({ payload: { requestId: "live", conversationId: id(41), type: "started", prompt: "新设备对话" } });
  });
  expect(screen.getAllByRole("tab")).toHaveLength(12);
  expect(screen.getAllByTestId("chat")).toHaveLength(12);
  expect(screen.getByRole("button", { name: "新设备对话" })).toBeTruthy();
});

it("keeps the last successful history visible after a read failure and supports retry", async () => {
  render(<ConversationTabs />);
  await screen.findByRole("button", { name: "设备问题 39" });
  command.mockImplementation(async (name: string) => {
    if (name === "list_chat_history") throw new Error("历史文件损坏");
    return [];
  });
  await act(async () => { for (const listener of handlers.get("chat-history-updated") ?? []) listener({ payload: null }); });
  expect((await screen.findByRole("alert")).textContent).toContain("历史文件损坏");
  expect(screen.getByRole("button", { name: "设备问题 39" })).toBeTruthy();
  command.mockImplementation(async () => []);
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
