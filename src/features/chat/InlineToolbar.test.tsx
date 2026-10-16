// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InlineToolbar } from "./ChatPresentation";

afterEach(cleanup);
it("dismisses the options on outside pointer, Escape and selection", () => {
  const update = vi.fn();
  render(<InlineToolbar message="hello" isSpeaking={false} copyFeedback={false} htmlPreviewEnabled={false} onCopy={vi.fn()} onSpeech={vi.fn()} onSave={vi.fn()} onUpdateHtmlPreview={update} onClearContext={vi.fn()} onOpenPanel={vi.fn()} />);
  const summary = screen.getByLabelText("更多操作");
  const menu = summary.closest("details")!;
  menu.open = true;
  fireEvent.pointerDown(screen.getByText("HTML 预览"));
  expect(menu.open).toBe(true);
  fireEvent.pointerDown(document.body);
  expect(menu.open).toBe(false);
  menu.open = true;
  fireEvent.keyDown(document, { key: "Escape" });
  expect(menu.open).toBe(false);
  expect(document.activeElement).toBe(summary);
  menu.open = true;
  fireEvent.click(screen.getByText("HTML 预览"));
  expect(update).toHaveBeenCalledWith(true);
  expect(menu.open).toBe(false);
});

it("consumes Escape before the chat window can hide, while allowing it when the menu is closed", () => {
  const hideWindow = vi.fn();
  render(<div onKeyDown={hideWindow}><InlineToolbar message="hello" isSpeaking={false} copyFeedback={false} htmlPreviewEnabled={false} onCopy={vi.fn()} onSpeech={vi.fn()} onSave={vi.fn()} onUpdateHtmlPreview={vi.fn()} onClearContext={vi.fn()} onOpenPanel={vi.fn()} /></div>);
  const summary = screen.getByLabelText("更多操作");
  const menu = summary.closest("details")!;
  menu.open = true;
  fireEvent.keyDown(summary, { key: "Escape" });
  expect(menu.open).toBe(false);
  expect(hideWindow).not.toHaveBeenCalled();
  fireEvent.keyDown(summary, { key: "Escape" });
  expect(hideWindow).toHaveBeenCalledOnce();
});
