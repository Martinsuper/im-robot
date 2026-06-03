import { describe, expect, it } from "vitest";
import { extractHtmlPreviewSource } from "./HtmlPreviewFrame";

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
