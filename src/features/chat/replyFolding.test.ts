import { describe, expect, it } from "vitest";
import {
  FOLD_TARGET,
  FOLD_THRESHOLD,
  foldReply,
  foldedRemainder,
  hasCodeBlock,
  shouldFoldReply,
} from "./replyFolding";

describe("hasCodeBlock", () => {
  it("认出围栏代码块", () => {
    expect(hasCodeBlock("说明\n```ts\nconst a = 1;\n```")).toBe(true);
    expect(hasCodeBlock("~~~\ncode\n~~~")).toBe(true);
  });

  it("行内 code 不算代码块", () => {
    expect(hasCodeBlock("用 `npm install` 安装")).toBe(false);
  });
});

describe("shouldFoldReply", () => {
  it("短回复不折叠", () => {
    expect(shouldFoldReply("很短")).toBe(false);
    expect(shouldFoldReply("字".repeat(FOLD_THRESHOLD))).toBe(false);
  });

  it("超过阈值的长回复要折叠", () => {
    expect(shouldFoldReply("字".repeat(FOLD_THRESHOLD + 1))).toBe(true);
  });

  it("含代码块的长回复不折叠——按字数截断会把代码切成半截", () => {
    const long = `说明\n\n\`\`\`ts\n${"const a = 1;\n".repeat(200)}\`\`\``;
    expect(long.length).toBeGreaterThan(FOLD_THRESHOLD);
    expect(shouldFoldReply(long)).toBe(false);
  });
});

describe("foldReply", () => {
  it("短回复原样返回", () => {
    expect(foldReply("短")).toBe("短");
  });

  it("在段落边界截断，不把段落切成半句", () => {
    const paragraph = "这是第一段。".repeat(60); // 360 字
    const second = "这是第二段。".repeat(60);
    const folded = foldReply(`${paragraph}\n\n${second}`);
    expect(folded).toBe(paragraph);
    expect(folded.length).toBeLessThan(FOLD_TARGET + 20);
  });

  it("没有空行时退到行边界", () => {
    const line = "这是一行内容。\n";
    const folded = foldReply(line.repeat(200));
    expect(folded.endsWith("\n")).toBe(false);
    expect(folded.length).toBeGreaterThan(FOLD_TARGET * 0.4);
    expect(folded.length).toBeLessThanOrEqual(FOLD_TARGET);
  });

  it("没有换行时退到句子边界", () => {
    const folded = foldReply("这是一个句子。".repeat(200));
    expect(folded.endsWith("。")).toBe(true);
    expect(folded.length).toBeLessThanOrEqual(FOLD_TARGET);
  });

  it("完全没有标点时仍然给出结果，不会返回空", () => {
    const folded = foldReply("字".repeat(FOLD_THRESHOLD + 100));
    expect(folded.length).toBeGreaterThan(0);
    expect(folded.length).toBeLessThanOrEqual(FOLD_TARGET);
  });

  it("折叠结果必须短于原文，展开才有意义", () => {
    const original = "段落一。\n\n段落二。\n\n".repeat(100);
    expect(foldReply(original).length).toBeLessThan(original.length);
  });
});

describe("foldedRemainder", () => {
  it("给出剩余字数，供「展开全部」提示用", () => {
    const original = "一段。\n\n".repeat(300);
    const remainder = foldedRemainder(original);
    expect(remainder).toBe(original.length - foldReply(original).length);
    expect(remainder).toBeGreaterThan(0);
  });
});
