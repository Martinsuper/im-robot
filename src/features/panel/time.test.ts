import { describe, expect, it } from "vitest";
import {
  dayOffset,
  findOverlaps,
  formatClock,
  formatCountdown,
  formatRange,
  greetingFor,
  isOverdue,
  isSameDay,
  isToday,
  summarizeTodayCount,
} from "./time";

/** 用本地时间构造秒级时间戳，避免测试依赖机器时区偏移。 */
function at(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return Math.floor(new Date(year, month - 1, day, hour, minute, 0, 0).getTime() / 1000);
}

const REFERENCE = at(2026, 3, 10, 14, 30); // 2026-03-10 14:30 本地时间

describe("自然日判定", () => {
  it("同一天的凌晨与深夜算同一天", () => {
    expect(isSameDay(at(2026, 3, 10, 0, 0), at(2026, 3, 10, 23, 59))).toBe(true);
  });

  it("跨午夜就不算同一天——这是「今天」列表最容易错的地方", () => {
    expect(isSameDay(at(2026, 3, 10, 23, 59), at(2026, 3, 11, 0, 0))).toBe(false);
  });

  it("isToday 相对参考时刻判断", () => {
    expect(isToday(at(2026, 3, 10, 8, 0), REFERENCE)).toBe(true);
    expect(isToday(at(2026, 3, 11, 8, 0), REFERENCE)).toBe(false);
  });

  it("dayOffset 区分昨天 / 今天 / 明天", () => {
    expect(dayOffset(at(2026, 3, 9, 23, 0), REFERENCE)).toBe(-1);
    expect(dayOffset(at(2026, 3, 10, 0, 1), REFERENCE)).toBe(0);
    expect(dayOffset(at(2026, 3, 11, 23, 59), REFERENCE)).toBe(1);
    expect(dayOffset(at(2026, 3, 17, 9, 0), REFERENCE)).toBe(7);
  });
});

describe("时间文案", () => {
  it("formatClock 补零", () => {
    expect(formatClock(at(2026, 3, 10, 9, 5))).toBe("09:05");
    expect(formatClock(at(2026, 3, 10, 23, 59))).toBe("23:59");
  });

  it("formatRange 在起止相同时只显示一个时间", () => {
    expect(formatRange(at(2026, 3, 10, 10, 0), at(2026, 3, 10, 11, 0))).toBe("10:00–11:00");
    expect(formatRange(at(2026, 3, 10, 10, 0), undefined)).toBe("10:00");
    expect(formatRange(at(2026, 3, 10, 10, 0), at(2026, 3, 10, 10, 0))).toBe("10:00");
  });

  it("formatCountdown 处理跨分钟与负数", () => {
    expect(formatCountdown(0)).toBe("00:00");
    expect(formatCountdown(59)).toBe("00:59");
    expect(formatCountdown(1122)).toBe("18:42");
    expect(formatCountdown(-5)).toBe("00:00");
  });

  it("greetingFor 按时段给出不同问候", () => {
    expect(greetingFor(at(2026, 3, 10, 2, 0))).toBe("夜深了");
    expect(greetingFor(at(2026, 3, 10, 9, 0))).toBe("早上好");
    expect(greetingFor(at(2026, 3, 10, 12, 0))).toBe("中午好");
    expect(greetingFor(at(2026, 3, 10, 16, 0))).toBe("下午好");
    expect(greetingFor(at(2026, 3, 10, 21, 0))).toBe("晚上好");
  });

  it("summarizeTodayCount 在 0 件时返回 null，让调用方决定文案", () => {
    expect(summarizeTodayCount(0)).toBeNull();
    expect(summarizeTodayCount(-1)).toBeNull();
    expect(summarizeTodayCount(3)).toBe("今天有 3 件事");
  });
});

describe("已错过", () => {
  it("提醒过了时间且未完成才算已错过", () => {
    expect(isOverdue({ kind: "reminder", startAt: REFERENCE - 60, status: "pending" }, REFERENCE)).toBe(true);
    expect(isOverdue({ kind: "reminder", startAt: REFERENCE - 60, status: "done" }, REFERENCE)).toBe(false);
    expect(isOverdue({ kind: "reminder", startAt: REFERENCE + 60, status: "pending" }, REFERENCE)).toBe(false);
  });

  it("日程永远不算已错过——到点就过去了，标已错过会让用户以为要补做", () => {
    expect(isOverdue({ kind: "event", startAt: REFERENCE - 3600, endAt: REFERENCE + 3600 }, REFERENCE)).toBe(false);
  });
});

describe("重叠检测", () => {
  const event = (id: string, start: number, end: number) => ({ id, kind: "event" as const, startAt: start, endAt: end });

  it("区间真正重叠时报告", () => {
    const overlaps = findOverlaps([
      event("a", at(2026, 3, 10, 10, 0), at(2026, 3, 10, 11, 0)),
      event("b", at(2026, 3, 10, 10, 30), at(2026, 3, 10, 11, 30)),
    ]);
    expect(overlaps).toEqual([{ leftId: "a", rightId: "b" }]);
  });

  it("首尾相接不算重叠", () => {
    const overlaps = findOverlaps([
      event("a", at(2026, 3, 10, 10, 0), at(2026, 3, 10, 11, 0)),
      event("b", at(2026, 3, 10, 11, 0), at(2026, 3, 10, 12, 0)),
    ]);
    expect(overlaps).toEqual([]);
  });

  it("提醒不参与冲突判断——时间点和区间重叠是正常用法", () => {
    const overlaps = findOverlaps([
      event("a", at(2026, 3, 10, 10, 0), at(2026, 3, 10, 11, 0)),
      { id: "r", kind: "reminder", startAt: at(2026, 3, 10, 10, 30) },
    ]);
    expect(overlaps).toEqual([]);
  });

  it("零长度区间不与自己冲突", () => {
    const zero = at(2026, 3, 10, 10, 0);
    expect(findOverlaps([event("a", zero, zero), event("b", zero, zero)])).toEqual([]);
  });
});
