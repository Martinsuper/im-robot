/**
 * 「今天」时间线用到的时间工具。
 *
 * 全部是纯函数，因此可以被单测覆盖——时间边界（今天/明天/已错过）是这类界面
 * 最容易出错、又最难靠肉眼发现的地方：23:59 加一条提醒，第二天打开时
 * 到底算「今天」还是「已错过」，只有测试说得清。
 */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** 秒级 Unix 时间戳（后端一律用秒）。 */
export type UnixSeconds = number;

export function nowSeconds(): UnixSeconds {
  return Math.floor(Date.now() / 1000);
}

function startOfDay(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

/** 两个时间戳是否落在同一个自然日（本地时区）。 */
export function isSameDay(left: UnixSeconds, right: UnixSeconds): boolean {
  return startOfDay(new Date(left * 1000)).getTime() === startOfDay(new Date(right * 1000)).getTime();
}

export function isToday(at: UnixSeconds, reference: UnixSeconds = nowSeconds()): boolean {
  return isSameDay(at, reference);
}

/** 自然日差值：0 = 今天，1 = 明天，-1 = 昨天。 */
export function dayOffset(at: UnixSeconds, reference: UnixSeconds = nowSeconds()): number {
  const left = startOfDay(new Date(at * 1000)).getTime();
  const right = startOfDay(new Date(reference * 1000)).getTime();
  return Math.round((left - right) / (DAY_MS));
}

export function formatClock(at: UnixSeconds): string {
  const date = new Date(at * 1000);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 时间线上的一条区间（日程）。缺 endAt 时退化为同一时刻。 */
export function formatRange(startAt: UnixSeconds, endAt: number | undefined): string {
  const start = formatClock(startAt);
  const end = formatClock(endAt ?? startAt);
  return start === end ? start : `${start}–${end}`;
}

/**
 * 是否已错过：时间点已过去、且仍是待办状态。
 *
 * 只对提醒有意义——日程到点就是过去了，标「已错过」会让用户以为需要补做。
 */
export interface OverdueCandidate {
  startAt: UnixSeconds;
  kind: "reminder" | "event";
  status?: string;
  /** 日程的结束时间。判定用不到，但真实对象会带，声明出来避免调用方被迫裁剪字段。 */
  endAt?: UnixSeconds;
}

export function isOverdue(item: OverdueCandidate, reference: UnixSeconds = nowSeconds()): boolean {
  if (item.kind !== "reminder") return false;
  if (item.status === "done") return false;
  return item.startAt < reference;
}

/** 按时段问候。 */
export function greetingFor(reference: UnixSeconds = nowSeconds()): string {
  const hour = new Date(reference * 1000).getHours();
  if (hour < 5) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 13) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

/** 「今天有 3 件事」这类摘要；0 件时返回 null，由调用方决定文案。 */
export function summarizeTodayCount(count: number): string | null {
  if (count <= 0) return null;
  return `今天有 ${count} 件事`;
}

export interface Overlap {
  leftId: string;
  rightId: string;
}

/**
 * 找出重叠的日程区间，用于「有 N 处时间冲突」提示。
 *
 * 只有日程参与判断：提醒是一个时间点，和区间重叠不是「冲突」而是正常使用。
 */
export function findOverlaps(
  items: Array<{ id: string; kind: "reminder" | "event"; startAt: UnixSeconds; endAt?: number }>,
): Overlap[] {
  const events = items
    .filter((item) => item.kind === "event")
    .map((item) => ({ id: item.id, startAt: item.startAt, endAt: item.endAt ?? item.startAt }))
    .sort((left, right) => left.startAt - right.startAt);

  const overlaps: Overlap[] = [];
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const current = events[index];
    // 零长度区间（start === end）不视为冲突
    if (current.startAt < previous.endAt && previous.endAt > previous.startAt) {
      overlaps.push({ leftId: previous.id, rightId: current.id });
    }
  }
  return overlaps;
}

/** 秒 → mm:ss，用于专注倒计时。 */
export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  return `${String(minutes).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}
