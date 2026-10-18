// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { HistoryItem } from "./ChatPresentation";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("../app/appShared", () => ({ PetSprite: () => null }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../app/appRuntime", () => ({ isTauriRuntime: true }));
vi.mock("../i18n/I18nProvider", () => ({ useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }) }));
const entry = { id: "history-html", prompt: "生成页面", response: '说明\n```html\n<h1>History preview</h1>\n```', createdAt: 1 };
const props = { entry, isExpanded: true, htmlPreviewEnabled: true, onToggle: vi.fn() };
afterEach(() => { cleanup(); invoke.mockReset(); });
it("previews HTML in expanded history with the same standalone window controls", async () => {
  invoke.mockResolvedValue("history-frame");
  render(<HistoryItem {...props} />);
  await waitFor(() => expect(screen.getByTitle("Piko HTML 预览").getAttribute("src")).toContain("/frame/history-frame"));
  expect(invoke).toHaveBeenCalledWith("create_html_preview_frame", { html: expect.stringContaining("<h1>History preview</h1>"), sourceChatId:entry.id });
  expect(screen.getByRole("button", { name: "独立窗口打开" })).toBeTruthy();
});
it("does not create previews until history is expanded and releases the frame on collapse", async () => {
  invoke.mockResolvedValue("history-frame");
  const view = render(<HistoryItem {...props} isExpanded={false} />);
  expect(invoke).not.toHaveBeenCalled();
  view.rerender(<HistoryItem {...props} />);
  await waitFor(() => expect(screen.getByTitle("Piko HTML 预览").getAttribute("src")).toContain("/frame/history-frame"));
  view.rerender(<HistoryItem {...props} isExpanded={false} />);
  expect(screen.queryByTitle("Piko HTML 预览")).toBeNull();
  expect(invoke).toHaveBeenCalledWith("remove_html_preview_frame", { token: "history-frame" });
});
it("restores Markdown when preview is disabled and preserves non-HTML history", async () => {
  invoke.mockResolvedValue("history-frame");
  const view = render(<HistoryItem {...props} />);
  await waitFor(() => expect(screen.getByTitle("Piko HTML 预览").getAttribute("src")).toContain("/frame/history-frame"));
  view.rerender(<HistoryItem {...props} htmlPreviewEnabled={false} />);
  expect(screen.queryByTitle("Piko HTML 预览")).toBeNull();
  expect(screen.getByRole("button", { name: "复制代码" })).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("remove_html_preview_frame", { token: "history-frame" });
  view.rerender(<HistoryItem {...props} entry={{ ...entry, response: "普通历史回复" }} />);
  expect(screen.getByText("普通历史回复")).toBeTruthy();
  expect(screen.queryByTitle("Piko HTML 预览")).toBeNull();
});
it("also previews complete raw HTML documents from older history", async () => {
  invoke.mockResolvedValue("raw-frame");
  render(<HistoryItem {...props} entry={{ ...entry, response: '<!DOCTYPE html><html><body><h1>Old document</h1></body></html>' }} />);
  await waitFor(() => expect(screen.getByTitle("Piko HTML 预览").getAttribute("src")).toContain("/frame/raw-frame"));
  expect(invoke).toHaveBeenCalledWith("create_html_preview_frame", { html: expect.stringContaining("Old document"), sourceChatId:entry.id });
});

it("sets the selected history view explicitly and keeps repeated tab clicks idempotent", async () => {
  invoke.mockResolvedValue("history-frame");
  function ControlledHistory() {
    const [source, setSource] = useState(false);
    return <HistoryItem {...props} previewAsSource={source} onPreviewViewChange={(view) => setSource(view === "source")} />;
  }
  render(<ControlledHistory />);
  const preview = screen.getByRole("tab", { name: "预览" });
  const source = screen.getByRole("tab", { name: "源码" });
  fireEvent.click(preview);
  expect(preview.getAttribute("aria-selected")).toBe("true");
  fireEvent.click(source);
  expect(source.getAttribute("aria-selected")).toBe("true");
  expect(screen.getByText("<h1>History preview</h1>")).toBeTruthy();
  fireEvent.click(source);
  expect(source.getAttribute("aria-selected")).toBe("true");
  fireEvent.click(preview);
  expect(preview.getAttribute("aria-selected")).toBe("true");
  await waitFor(() => expect(screen.getByTitle("Piko HTML 预览").getAttribute("src")).toContain("/frame/history-frame"));
});
