/**
 * 空状态的建议问题（02 §11）。
 *
 * 建议要随**时段**变化：早上推「梳理今天安排」，晚上推「回顾一下今天」，
 * 比固定三句更像一个真的在场的人。这也是 02 §11 明确要求的。
 *
 * 纯函数，便于单测覆盖时段边界。
 */

export interface Suggestion {
  label: string;
  /** 点击后填入输入框的内容（**不自动发送**，02 §11）。 */
  prompt: string;
}

const MORNING: Suggestion[] = [
  { label: "梳理今天", prompt: "帮我梳理一下今天要做的事" },
  { label: "安排提醒", prompt: "提醒我 10 分钟后喝水" },
  { label: "看看安排", prompt: "今天有什么安排" },
];

const AFTERNOON: Suggestion[] = [
  { label: "整理想法", prompt: "帮我整理这段文字的重点：" },
  { label: "记一笔", prompt: "帮我记一件事：" },
  { label: "看看安排", prompt: "今天还有什么安排" },
];

const EVENING: Suggestion[] = [
  { label: "回顾今天", prompt: "帮我回顾一下今天做了什么" },
  { label: "记一笔", prompt: "帮我记一件事：" },
  { label: "随便聊聊", prompt: "陪我聊一会儿吧" },
];

export function suggestionsFor(reference: Date = new Date()): Suggestion[] {
  const hour = reference.getHours();
  if (hour >= 5 && hour < 12) return MORNING;
  if (hour >= 12 && hour < 18) return AFTERNOON;
  return EVENING;
}
