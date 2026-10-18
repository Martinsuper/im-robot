// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HtmlPreviewFrame } from "./HtmlPreviewFrame";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../app/appRuntime", () => ({ isTauriRuntime: true }));
vi.mock("../i18n/I18nProvider", () => ({ useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }) }));
afterEach(() => { cleanup(); invoke.mockReset(); });
it("loads the backend frame and removes it on unmount", async () => {
  invoke.mockResolvedValue("test-frame");
  const view = render(<HtmlPreviewFrame source="<h1>Hello</h1>" />);
  await waitFor(() => expect(screen.getByTitle("Piko HTML 预览").getAttribute("src")).toContain("/frame/test-frame"));
  expect(invoke).toHaveBeenCalledWith("create_html_preview_frame", { html: expect.stringContaining("<h1>Hello</h1>") });
  view.unmount();
  expect(invoke).toHaveBeenCalledWith("remove_html_preview_frame", { token: "test-frame" });
});
it("shows a visible error when creation fails", async () => {
  invoke.mockRejectedValue(new Error("unknown command"));
  render(<HtmlPreviewFrame source="<h1>Hello</h1>" />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "HTML 预览加载失败，请重试或重启应用。");
});

it("removes a frame created after the component was unmounted", async () => {
  let resolve!: (token: string) => void;
  invoke.mockImplementation((command: string) => command === "create_html_preview_frame" ? new Promise<string>((done) => { resolve = done; }) : Promise.resolve());
  const view = render(<HtmlPreviewFrame source="<h1>Late</h1>" />);
  view.unmount();
  resolve("late-frame");
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("remove_html_preview_frame", { token: "late-frame" }));
});
it("replaces the frame when HTML changes and cleans up the old frame", async () => {
  invoke.mockImplementation((command: string, args: { html?: string }) => Promise.resolve(command === "create_html_preview_frame" ? (args.html?.includes("First") ? "first" : "second") : undefined));
  const view = render(<HtmlPreviewFrame source="<h1>First</h1>" />);
  await waitFor(() => expect(screen.getByTitle("Piko HTML 预览").getAttribute("src")).toContain("/frame/first"));
  view.rerender(<HtmlPreviewFrame source="<h1>Second</h1>" />);
  await waitFor(() => expect(screen.getByTitle("Piko HTML 预览").getAttribute("src")).toContain("/frame/second"));
  expect(invoke).toHaveBeenCalledWith("remove_html_preview_frame", { token: "first" });
});

it("opens an independent native preview with the current HTML snapshot", async () => {
  invoke.mockResolvedValue("test-frame");
  render(<HtmlPreviewFrame source="<h1>Detached</h1>" />);
  fireEvent.click(screen.getByRole("button", { name: "独立窗口打开" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_html_preview_window", { html: expect.stringContaining("<h1>Detached</h1>") }));
});
it("reports a detached window failure while keeping the embedded preview", async () => {
  invoke.mockImplementation((command: string) => command === "open_html_preview_window" ? Promise.reject(new Error("Window failed")) : Promise.resolve("test-frame"));
  render(<HtmlPreviewFrame source="<h1>Keep inline</h1>" />);
  fireEvent.click(screen.getByRole("button", { name: "独立窗口打开" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "独立窗口打开失败，请重试或允许弹出窗口。");
  expect(screen.getByTitle("Piko HTML 预览").getAttribute("src")).toContain("/frame/test-frame");
});

it("only accepts Escape messages from its own iframe with the matching channel", async () => {
  invoke.mockResolvedValue("dialog-frame");
  const onEscape = vi.fn();
  render(<HtmlPreviewFrame source="<h1>Modal preview</h1>" onEscape={onEscape} />);
  await waitFor(() => expect(screen.getByTitle("Piko HTML 预览").getAttribute("src")).toContain("/frame/dialog-frame"));
  const html = invoke.mock.calls.find((call) => call[0] === "create_html_preview_frame")![1].html as string;
  const channel = JSON.parse(html.match(/channel:(".*?")/)![1]);
  const iframe = screen.getByTitle("Piko HTML 预览") as HTMLIFrameElement;
  fireEvent(window, new MessageEvent("message", { source: window, data: { type: "piko-preview-escape", channel } }));
  fireEvent(window, new MessageEvent("message", { source: iframe.contentWindow, data: { type: "piko-preview-escape", channel: "wrong-frame" } }));
  expect(onEscape).not.toHaveBeenCalled();
  fireEvent(window, new MessageEvent("message", { source: iframe.contentWindow, data: { type: "piko-preview-escape", channel } }));
  expect(onEscape).toHaveBeenCalledOnce();
});

it("network permission is per document and is revoked on a new source", async () => {
  invoke.mockResolvedValue("frame");
  const view = render(<HtmlPreviewFrame source="<h1>Private</h1>" />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_html_preview_frame", { html: expect.any(String) }));
  fireEvent.click(screen.getByRole("checkbox"));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("create_html_preview_frame", { html: expect.any(String), allowNetwork: true }));
  view.rerender(<HtmlPreviewFrame source="<h1>Another document</h1>" />);
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  await waitFor(() => expect(invoke.mock.calls.filter((call) => call[0] === "create_html_preview_frame").slice(-1)[0]?.[1]).not.toHaveProperty("allowNetwork"));
});
