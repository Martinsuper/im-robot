import { describe, expect, it } from "vitest";
import type { ChatHistoryEntry, Memo } from "../../types/appTypes";
import type { MemoryItem } from "../memory/memoryTypes";
import {
  SEARCH_RESULT_LIMIT,
  chatSearchFields,
  chatTimeBucket,
  containsKeyword,
  memorySearchFields,
  memoSearchFields,
  summarizeText,
} from "./recordsSearch";

const memo: Memo = {
  id: "m1",
  title: "版本复盘",
  content: "正文：把上周的发布问题列出来",
  category: "work",
  summary: "发布复盘摘要",
  tags: ["工作", "会议"],
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_100,
};

const memory: MemoryItem = {
  lastUsedAt: null,
  expiresAt: null,
  embeddingId: null,
  id: "r1",
  memoryType: "profile",
  title: "她在准备搬家",
  content: "下个月会搬到新城市",
  source: "conversation",
  importance: 0.8,
  confidence: 0.9,
  recencyScore: 0.5,
  privacyLevel: "publicToUser",
  status: "active",
  createdAt: 1_700_000_000,
  updatedAt: 1_700_000_100,
  tags: ["生活"],
  isPinned: false,
};

const chat: ChatHistoryEntry = {
  id: "c1",
  prompt: "帮我看看这段 SQL",
  response: "可以用 EXPLAIN 分析执行计划",
  createdAt: 1_700_000_000,
};

describe("unified search matches the fields each source promises", () => {
  it("matches memos on title / summary / content / tags", () => {
    expect(containsKeyword(memoSearchFields(memo), "版本")).toBe(true);
    expect(containsKeyword(memoSearchFields(memo), "发布复盘")).toBe(true);
    expect(containsKeyword(memoSearchFields(memo), "正文")).toBe(true);
    expect(containsKeyword(memoSearchFields(memo), "会议")).toBe(true);
    expect(containsKeyword(memoSearchFields(memo), "不存在")).toBe(false);
  });

  it("matches memories on title / content / tags only", () => {
    expect(containsKeyword(memorySearchFields(memory), "搬家")).toBe(true);
    expect(containsKeyword(memorySearchFields(memory), "生活")).toBe(true);
    // 技术字段不参与检索：置信度 0.9 与 source=conversation 都不该被搜到
    expect(memorySearchFields(memory)).not.toContain("confidence");
    expect(containsKeyword(memorySearchFields(memory), "conversation")).toBe(false);
  });

  it("matches chat history on prompt and response", () => {
    expect(containsKeyword(chatSearchFields(chat), "SQL")).toBe(true);
    expect(containsKeyword(chatSearchFields(chat), "EXPLAIN")).toBe(true);
    expect(containsKeyword(chatSearchFields(chat), "搬家")).toBe(false);
  });

  it("treats a blank keyword as no-match so the caller filters explicitly", () => {
    expect(containsKeyword("anything", "")).toBe(false);
    expect(containsKeyword("anything", "   ")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(containsKeyword("EXPLAIN", "explain")).toBe(true);
  });
});

describe("chat history time buckets", () => {
  // 2023-11-14 22:13 UTC，取一个固定参考点，避免测试跑到日界时变红。
  const reference = 1_700_000_000;
  const day = 24 * 60 * 60;

  it("puts today in today, the last 7 days in week, rest in earlier", () => {
    expect(chatTimeBucket(reference, reference)).toBe("today");
    expect(chatTimeBucket(reference - 2 * 60 * 60, reference)).toBe("today");
    expect(chatTimeBucket(reference - 3 * day, reference)).toBe("week");
    expect(chatTimeBucket(reference - 6 * day, reference)).toBe("week");
    expect(chatTimeBucket(reference - 8 * day, reference)).toBe("earlier");
  });
});

describe("presentation helpers", () => {
  it("flattens and truncates long text", () => {
    expect(summarizeText("  一行\n  两行  ")).toBe("一行 两行");
    expect(summarizeText("a".repeat(50), 10)).toBe("aaaaaaaaaa…");
    expect(summarizeText("   ")).toBe("");
  });

  it("caps each source in the grouped results", () => {
    expect(SEARCH_RESULT_LIMIT).toBe(8);
  });
});
