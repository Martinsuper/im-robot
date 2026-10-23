import type { ScheduleItem } from "../../types/appTypes";

export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function itemsForDay(items: ScheduleItem[], day: Date): ScheduleItem[] {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime() / 1000;
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime() / 1000;
  return items.filter(item => item.startAt < end && (item.kind === "event" && item.endAt && item.endAt > item.startAt ? item.endAt > start : item.startAt >= start));
}
