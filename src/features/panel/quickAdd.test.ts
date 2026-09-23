import { describe, expect, it } from "vitest";
import { parseChineseNumber, parseQuickAdd } from "./quickAdd";

/** 用本地时间构造参考时刻，避免测试依赖机器时区。 */
function at(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return Math.floor(new Date(year, month - 1, day, hour, minute, 0, 0).getTime() / 1000);
}

function clockOf(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// 2026-03-10 是周二
const TUESDAY = at(2026, 3, 10, 14, 30);

describe("parseChineseNumber", () => {
  it("阿拉伯数字与中文数字都认", () => {
    expect(parseChineseNumber("3")).toBe(3);
    expect(parseChineseNumber("十")).toBe(10);
    expect(parseChineseNumber("十二")).toBe(12);
    expect(parseChineseNumber("二十")).toBe(20);
    expect(parseChineseNumber("二十三")).toBe(23);
    expect(parseChineseNumber("两")).toBe(2);
  });

  it("认不出的返回 null，而不是猜一个数", () => {
    expect(parseChineseNumber("三三")).toBeNull();
    expect(parseChineseNumber("")).toBeNull();
    expect(parseChineseNumber("abc")).toBeNull();
  });
});

describe("03 §4.2 的四类模板", () => {
  it("「明天 10 点开会」→ 明天的日程，默认 1 小时", () => {
    const parsed = parseQuickAdd("明天 10 点开会", TUESDAY);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("event");
    expect(parsed!.title).toBe("开会");
    expect(clockOf(parsed!.startAt)).toBe("10:00");
    expect(parsed!.endAt! - parsed!.startAt).toBe(3600);
    // 差一天
    expect(parsed!.startAt - TUESDAY).toBeGreaterThan(19 * 3600);
  });

  it("「10 分钟后喝水」→ 提醒，now + 10 分钟", () => {
    const parsed = parseQuickAdd("10 分钟后喝水", TUESDAY);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("reminder");
    expect(parsed!.title).toBe("喝水");
    expect(parsed!.startAt - TUESDAY).toBe(600);
    expect(parsed!.repeat).toBe("none");
  });

  it("「每晚 9 点提醒我总结」→ 每天重复的提醒", () => {
    const parsed = parseQuickAdd("每晚 9 点提醒我总结", TUESDAY);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("reminder");
    expect(parsed!.title).toBe("总结");
    expect(clockOf(parsed!.startAt)).toBe("21:00");
    expect(parsed!.repeat).toBe("daily");
  });

  it("「周五下午 3 点项目复盘」→ 本周五 15:00 的日程", () => {
    const parsed = parseQuickAdd("周五下午 3 点项目复盘", TUESDAY);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("event");
    expect(parsed!.title).toBe("项目复盘");
    expect(clockOf(parsed!.startAt)).toBe("15:00");
    const day = new Date(parsed!.startAt * 1000);
    expect(day.getDay()).toBe(5);
  });
});

describe("时间表达", () => {
  it("支持中文数字与半点", () => {
    expect(clockOf(parseQuickAdd("明天下午三点半开会", TUESDAY)!.startAt)).toBe("15:30");
    expect(clockOf(parseQuickAdd("明早八点跑步", TUESDAY)!.startAt)).toBe("08:00");
    expect(clockOf(parseQuickAdd("明天 10:15 站会", TUESDAY)!.startAt)).toBe("10:15");
  });

  it("下午 / 晚上 会修正小时", () => {
    expect(clockOf(parseQuickAdd("明天下午 3 点评审", TUESDAY)!.startAt)).toBe("15:00");
    expect(clockOf(parseQuickAdd("明晚 8 点电话", TUESDAY)!.startAt)).toBe("20:00");
    // 已经说了 20 点，再加「晚上」不应变成 32 点
    expect(clockOf(parseQuickAdd("明晚 20 点电话", TUESDAY)!.startAt)).toBe("20:00");
  });

  it("裸时间已过则顺延到明天，避免一创建就是已错过", () => {
    // 参考时刻是 14:30，写「9 点」应落到明天 09:00
    const parsed = parseQuickAdd("9 点开会", TUESDAY);
    expect(parsed).not.toBeNull();
    expect(clockOf(parsed!.startAt)).toBe("09:00");
    expect(parsed!.startAt).toBeGreaterThan(TUESDAY);
  });

  it("明确写了「今天」就不会顺延", () => {
    const parsed = parseQuickAdd("今天 9 点开会", TUESDAY);
    expect(clockOf(parsed!.startAt)).toBe("09:00");
    expect(parsed!.startAt).toBeLessThan(TUESDAY);
  });

  it("工作日与每周", () => {
    const workday = parseQuickAdd("工作日 9 点提醒我打卡", TUESDAY)!;
    expect(workday.repeat).toBe("weekdays");
    const weekly = parseQuickAdd("每周一 10 点周会", TUESDAY)!;
    expect(weekly.repeat).toBe("weekly");
    expect(clockOf(weekly.startAt)).toBe("10:00");
    expect(new Date(weekly.startAt * 1000).getDay()).toBe(1);
  });

  it("周X 指向同一天且时间已过时顺延一周", () => {
    // 参考是周二 14:30；「周二 9 点」应落到下周二
    const parsed = parseQuickAdd("周二 9 点例会", TUESDAY)!;
    expect(new Date(parsed.startAt * 1000).getDay()).toBe(2);
    expect(parsed.startAt).toBeGreaterThan(TUESDAY + 6 * 24 * 3600);
  });

  it("显式时长覆盖默认 1 小时，且不残留在标题里", () => {
    const parsed = parseQuickAdd("明天 10 点评审 2 小时", TUESDAY)!;
    expect(parsed.endAt! - parsed.startAt).toBe(7200);
    expect(parsed.title).toBe("评审");
  });
});

describe("拒绝猜测", () => {
  it("没有时间表达时返回 null，交给手动表单", () => {
    expect(parseQuickAdd("帮我记住这件事", TUESDAY)).toBeNull();
    expect(parseQuickAdd("", TUESDAY)).toBeNull();
    expect(parseQuickAdd("   ", TUESDAY)).toBeNull();
  });

  it("只有时间没有内容时返回 null，而不是造一条空标题", () => {
    expect(parseQuickAdd("明天 10 点", TUESDAY)).toBeNull();
  });

  it("非法小时被拒绝", () => {
    expect(parseQuickAdd("明天 25 点开会", TUESDAY)).toBeNull();
  });
});
