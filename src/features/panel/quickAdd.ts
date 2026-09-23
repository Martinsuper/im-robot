import type { ReminderRepeat } from "../../types/appTypes";
import { nowSeconds, type UnixSeconds } from "./time";

/**
 * 快速添加的自然语言解析（03 §4.2）。
 *
 * 只做**本地、确定性**的模板匹配，不调用模型：
 * - 这四类表达覆盖了绝大多数真实输入，本地解析不需要网络、不会失败、响应即时；
 * - 更自由的表达交给模型，走对话窗口的创建工具与确认流程（模块 02）。
 *
 * 设计取舍：解析不出来时返回 `null`，由界面提示「没太听懂，手动选个时间吧」
 * 并展开手动表单——**不猜**。猜错时间比让用户点两下更糟。
 */

export interface ParsedQuickAdd {
  kind: "reminder" | "event";
  title: string;
  startAt: UnixSeconds;
  /** 仅 event：默认 1 小时，或输入里显式给出的时长。 */
  endAt?: UnixSeconds;
  /** 仅 reminder。 */
  repeat?: ReminderRepeat;
}

const CHINESE_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

const WEEKDAY_NAMES: Record<string, number> = {
  日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
};

/** 解析「三」「十二」「二十」这类中文数字；认不出返回 null。 */
export function parseChineseNumber(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === "十") return 10;
  // 十X
  if (raw.length === 2 && raw.startsWith("十")) {
    const ones = CHINESE_DIGITS[raw[1]];
    return ones === undefined ? null : 10 + ones;
  }
  // X十 / X十Y
  if (raw.includes("十")) {
    const [tens, ones] = raw.split("十");
    const tensValue = CHINESE_DIGITS[tens];
    if (tensValue === undefined) return null;
    if (!ones) return tensValue * 10;
    const onesValue = CHINESE_DIGITS[ones];
    return onesValue === undefined ? null : tensValue * 10 + onesValue;
  }
  const single = CHINESE_DIGITS[raw];
  return single === undefined ? null : single;
}

interface ClockMatch {
  hour: number;
  minute: number;
  /** 匹配到的原文片段，用于从标题里剔除。 */
  text: string;
}

/** 从文本里抓「…点…」形式的时间。 */
function findClock(text: string): ClockMatch | null {
  // 支持 `3 点` `3点半` `3点15` `3点一刻` `15:30` `下午 3 点`
  const colon = text.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (colon) {
    const hour = Number(colon[1]);
    const minute = Number(colon[2]);
    if (hour <= 23 && minute <= 59) return { hour, minute, text: colon[0] };
  }
  const pattern = /([零一二两三四五六七八九十\d]{1,3})\s*点\s*(半|一刻|三刻|[零一二三四五六七八九十\d]{1,3}分?)?/;
  const match = text.match(pattern);
  if (!match) return null;
  const hour = parseChineseNumber(match[1]);
  if (hour === null || hour > 23) return null;
  let minute = 0;
  const suffix = match[2];
  if (suffix === "半") minute = 30;
  else if (suffix === "一刻") minute = 15;
  else if (suffix === "三刻") minute = 45;
  else if (suffix) {
    const parsed = parseChineseNumber(suffix.replace("分", ""));
    if (parsed === null || parsed > 59) return null;
    minute = parsed;
  }
  return { hour, minute, text: match[0] };
}

/** 「下午 / 晚上 / 中午 / 凌晨」对小时的修正。 */
function applyMeridiem(hour: number, text: string): number {
  if (/凌晨/.test(text)) return hour === 12 ? 0 : hour;
  // 注意把「明早 / 明晚」这类合成词也算进来：只说「晚」会漏掉「明晚 8 点」。
  if (/早上|上午|早晨|明早|一早/.test(text)) return hour;
  if (/中午/.test(text)) return hour < 11 ? hour + 12 : hour;
  if (/下午|傍晚/.test(text)) return hour < 12 ? hour + 12 : hour;
  // 「每晚 9 点」里的「晚」也要算进傍晚，否则会被当成早上 9 点。
  if (/晚上|今晚|明晚|每晚|夜里|晚间/.test(text)) return hour < 12 ? hour + 12 : hour;
  return hour;
}

function startOfDayFrom(at: UnixSeconds): Date {
  const date = new Date(at * 1000);
  date.setHours(0, 0, 0, 0);
  return date;
}

function atLocal(date: Date, hour: number, minute: number): UnixSeconds {
  const next = new Date(date);
  next.setHours(hour, minute, 0, 0);
  return Math.floor(next.getTime() / 1000);
}

/** 去掉时间表达与常见的引导词，剩下的当标题。 */
function extractTitle(input: string, timeText: string): string {
  let title = input.replace(timeText, " ");
  // 日期词、周几、时段词都要剔除，否则标题会残留「周五 3 点项目复盘」这种半截文本
  title = title.replace(/(凌晨|早上|上午|早晨|中午|下午|傍晚|晚上|今晚|明晚|明早|夜里|明天|今天|后天|每天|每晚|每日|工作日)/g, " ");
  title = title.replace(/(每周|每个)?(周|星期|礼拜)[一二三四五六日天]/g, " ");
  // 时长表达也不该留在标题里：「评审 2 小时」→「评审」
  title = title.replace(/[零一二两三四五六七八九十\d]{1,3}\s*(小时|分钟)\s*(的)?(会|会议|事情)?\s*$/, " ");
  // 先归一化空白再剥引导词：否则「每晚 9 点提醒我总结」去掉时间后残留的前导空格
  // 会让 ^ 锚定的正则失配，标题里留下「提醒我总结」。
  title = title.replace(/\s+/g, " ").trim();
  title = title.replace(/^(提醒我|提醒|记得|要|去|帮我)\s*/, "");
  title = title.replace(/\s*(提醒我|提醒)$/, "");
  return title.trim();
}

/**
 * @param input 用户输入
 * @param reference 参考时刻（默认现在）。可注入以便测试。
 * @returns 解析结果；无法确定时间时返回 null（调用方应展开手动表单）
 */
export function parseQuickAdd(input: string, reference: UnixSeconds = nowSeconds()): ParsedQuickAdd | null {
  const text = input.trim();
  if (!text) return null;

  // --- 相对时间：N 分钟后 / N 小时后 ---
  const relative = text.match(/([零一二两三四五六七八九十\d]{1,3})\s*(分钟|分|小时|个小时)\s*(后|之后|以后)/);
  if (relative) {
    const amount = parseChineseNumber(relative[1]);
    if (amount !== null && amount > 0) {
      const isHour = relative[2].includes("小时");
      const startAt = reference + amount * (isHour ? 3600 : 60);
      const title = extractTitle(text, relative[0]) || "提醒";
      return { kind: "reminder", title, startAt, repeat: "none" };
    }
  }

  const clock = findClock(text);
  if (!clock) return null;
  const hour = applyMeridiem(clock.hour, text);
  if (hour > 23) return null;

  const today = startOfDayFrom(reference);

  // --- 每天 / 每晚 ---
  if (/(每天|每晚|每日)/.test(text)) {
    let startAt = atLocal(today, hour, clock.minute);
    if (startAt <= reference) startAt += 24 * 3600;
    const title = extractTitle(text, clock.text) || "提醒";
    return { kind: "reminder", title, startAt, repeat: "daily" };
  }

  // --- 工作日 ---
  if (/工作日/.test(text)) {
    let startAt = atLocal(today, hour, clock.minute);
    if (startAt <= reference) startAt += 24 * 3600;
    const title = extractTitle(text, clock.text) || "提醒";
    return { kind: "reminder", title, startAt, repeat: "weekdays" };
  }

  // --- 周X ---
  const weekday = text.match(/(?:每周|每个)?(?:周|星期|礼拜)([一二三四五六日天])/);
  if (weekday) {
    const target = WEEKDAY_NAMES[weekday[1]];
    if (target === undefined) return null;
    const current = today.getDay();
    let delta = (target - current + 7) % 7;
    if (delta === 0) {
      // 今天就是那天：时间已过则算下周
      const candidate = atLocal(today, hour, clock.minute);
      if (candidate <= reference) delta = 7;
    }
    const startAt = atLocal(today, hour, clock.minute) + delta * 24 * 3600;
    const title = extractTitle(text, clock.text) || "安排";
    if (/每周|每个/.test(text)) {
      return { kind: "reminder", title, startAt, repeat: "weekly" };
    }
    return { kind: "event", title, startAt, endAt: startAt + 3600 };
  }

  // --- 明天 / 后天 / 今天（或裸时间） ---
  let dayOffset = 0;
  if (/后天/.test(text)) dayOffset = 2;
  else if (/明天|明早|明晚/.test(text)) dayOffset = 1;
  let startAt = atLocal(today, hour, clock.minute) + dayOffset * 24 * 3600;

  // 裸时间（没有日期词）：已经过了就顺延到明天，避免一创建就是「已错过」
  if (dayOffset === 0 && !/(今天|今晚|今早|今天下午)/.test(text) && startAt <= reference) {
    startAt += 24 * 3600;
  }

  const title = extractTitle(text, clock.text);
  if (!title) return null;

  // 显式时长：「开 2 小时会」
  const duration = text.match(/([零一二两三四五六七八九十\d]{1,3})\s*(小时|分钟)\s*(的)?(会|会议|事情)?$/);
  let endAt = startAt + 3600;
  if (duration) {
    const amount = parseChineseNumber(duration[1]);
    if (amount !== null && amount > 0) {
      endAt = startAt + amount * (duration[2] === "小时" ? 3600 : 60);
    }
  }

  return { kind: "event", title, startAt, endAt };
}
