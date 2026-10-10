import { afterEach, describe, expect, it, vi } from "vitest";
import { extractHtmlPreviewSource, previewFrameUrl } from "./HtmlPreviewFrame";

describe("previewFrameUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds an http URL on non-mac platforms", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 Windows NT 10.0" });
    expect(previewFrameUrl("frame-1")).toBe("http://preview.localhost/frame/frame-1");
  });

  it("builds a preview scheme URL on macOS", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)" });
    expect(previewFrameUrl("frame-2")).toBe("preview://localhost/frame/frame-2");
  });
});

describe("extractHtmlPreviewSource", () => {
  it("extracts a fenced html block even when the reply contains prose", () => {
    const message = [
      "你好呀！",
      "",
      "```html",
      "<!DOCTYPE html>",
      "<html lang=\"zh-CN\">",
      "  <body><h1>Flashcards</h1></body>",
      "</html>",
      "```",
      "",
      "使用说明：把它保存为 .html 文件。",
    ].join("\n");

    expect(extractHtmlPreviewSource(message)).toContain("<!DOCTYPE html>");
  });

  it("extracts a raw html document that appears after prose", () => {
    const message = [
      "我先说明一下。",
      "",
      "<!DOCTYPE html>",
      "<html lang=\"zh-CN\">",
      "  <body><h1>Flashcards</h1></body>",
      "</html>",
    ].join("\n");

    expect(extractHtmlPreviewSource(message)?.startsWith("<!DOCTYPE html>")).toBe(true);
  });
});
