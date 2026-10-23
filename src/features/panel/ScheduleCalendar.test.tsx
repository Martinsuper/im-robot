// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduleCalendar } from "./ScheduleCalendar";
import { itemsForDay } from "./scheduleCalendarData";
import type { ScheduleItem } from "../../types/appTypes";

afterEach(cleanup);
const at = (day: number, hour = 0) => new Date(2026, 9, day, hour).getTime() / 1000;
const items: ScheduleItem[] = [
  { id: "overnight", kind: "event", title: "跨天日程", startAt: at(22, 23), endAt: at(23, 2) },
  { id: "boundary", kind: "event", title: "午夜结束", startAt: at(22, 20), endAt: at(23) },
  { id: "reminder", kind: "reminder", title: "提醒", startAt: at(23, 20) },
];

describe("日历与安排", () => {
  it("跨天事项出现在覆盖的日期，午夜结束不计入次日", () => {
    expect(itemsForDay(items, new Date(2026, 9, 23)).map(item => item.id)).toEqual(["overnight", "reminder"]);
    expect(itemsForDay(items, new Date(2026, 9, 24))).toEqual([]);
  });
  it("按周一开始排列，并支持选日、跨年翻月和回到今天", () => {
    const onSelect = vi.fn();
    render(<ScheduleCalendar items={items} selected={new Date(2026, 9, 23)} today={new Date(2026, 9, 23)} onSelect={onSelect} />);
    const dates = screen.getByRole("group", { name: "选择日期" }).querySelectorAll("button");
    expect(dates[0].getAttribute("aria-label")).toBe("2026年9月28日，0件事");
    expect(screen.getByRole("button", { name: "2026年10月23日，2件事" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "2026年10月24日，0件事" }));
    expect(onSelect).toHaveBeenLastCalledWith(new Date(2026, 9, 24));
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: "下个月" }));
    expect(screen.getByText("2027 年 1 月")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "回到今天" }));
    expect(screen.getByText("2026 年 10 月")).toBeTruthy();
    expect(onSelect).toHaveBeenLastCalledWith(new Date(2026, 9, 23));
  });
});
