import type { ChatHistoryEntry, Memo, ScheduleItem } from "../../types/appTypes";
import { nowSeconds } from "./time";

/**
 * 浏览器预览（`?view=panel`）用的演示数据。
 *
 * 只在**非 Tauri 环境**下使用。理由：预览里没有 Rust 后端，`runCommand` 会走
 * fallback，于是每个 Tab 只能看到空状态——而空状态恰好是最不需要检查的布局。
 * 有了这份数据，`npm run test:e2e` 才能对着「有内容的今天」截图并断言，
 * 这也让 UI 改动的回归检查变成可能。
 *
 * 注意：这里的数据永远不进生产路径（真实运行时 `isTauriRuntime` 为 true）。
 */
export function previewScheduleItems(): ScheduleItem[] {
  const base = nowSeconds();
  const at = (hour: number, minute: number) => {
    const date = new Date();
    date.setHours(hour, minute, 0, 0);
    return Math.floor(date.getTime() / 1000);
  };
  const tomorrow = (hour: number) => at(hour, 0) + 24 * 3600;

  return [
    {
      id: "preview-reminder-1",
      kind: "reminder",
      title: "站起来活动一下",
      startAt: at(10, 30),
      status: "done",
      repeat: "none",
      source: "user",
    },
    {
      id: "preview-event-1",
      kind: "event",
      title: "项目评审",
      startAt: at(14, 0),
      endAt: at(15, 0),
      location: "会议室 A",
      source: "user",
    },
    {
      id: "preview-reminder-2",
      kind: "reminder",
      title: "提醒我给妈妈打电话",
      startAt: at(20, 0),
      status: "pending",
      repeat: "none",
      source: "user",
    },
    {
      id: "preview-event-2",
      kind: "event",
      title: "和设计师对齐首页改版",
      startAt: at(14, 30),
      endAt: at(15, 30),
      notes: "带上上一版的截图",
      source: "user",
    },
    {
      id: "preview-reminder-3",
      kind: "reminder",
      title: "每天早上提醒我看今日计划",
      startAt: tomorrow(9),
      status: "pending",
      repeat: "daily",
      source: "user",
    },
    {
      id: "preview-event-3",
      kind: "event",
      title: "季度复盘",
      startAt: tomorrow(15),
      endAt: tomorrow(17),
      source: "user",
    },
    {
      id: "preview-reminder-4",
      kind: "reminder",
      title: "交房租",
      startAt: base + 4 * 24 * 3600,
      status: "pending",
      repeat: "none",
      source: "user",
    },
  ];
}

/**
 * 记录 Tab 的演示备忘（04 §3.2）。
 *
 * 覆盖多个分类与「今天 / 更早」两种时间，好让分类 chip 与列表排序在预览里
 * 真的能被看到——只有空状态的预览是没法发现布局问题的。
 */
export function previewMemos(): Memo[] {
  const now = nowSeconds();
  const hoursAgo = (hours: number) => now - hours * 3600;

  return [
    {
      id: "preview-memo-1",
      title: "首页改版的三条原则",
      content: "1) 先给结论；2) 表单只留必填；3) 空状态要给下一步。",
      category: "idea",
      summary: "1) 先给结论；2) 表单只留必填；3) 空状态要给下一步。",
      tags: ["想法", "首页"],
      createdAt: hoursAgo(2),
      updatedAt: hoursAgo(2),
    },
    {
      id: "preview-memo-2",
      title: "季度复盘待办",
      content: "把上季度的三条失败决策写清楚，周五之前发给团队。",
      category: "task",
      summary: "把上季度的三条失败决策写清楚，周五之前发给团队。",
      tags: ["任务", "紧急"],
      createdAt: hoursAgo(6),
      updatedAt: hoursAgo(5),
    },
    {
      id: "preview-memo-3",
      title: "SQLite FTS5 笔记",
      content: "中文分词要用 unicode61，否则整段话会被当成一个 token。",
      category: "learning",
      summary: "中文分词要用 unicode61，否则整段话会被当成一个 token。",
      tags: ["学习", "代码"],
      createdAt: hoursAgo(30),
      updatedAt: hoursAgo(30),
    },
    {
      id: "preview-memo-4",
      title: "搬家要带的清单",
      content: "证件、常用药、两台显示器的线，别忘了猫砂盆。",
      category: "life",
      summary: "证件、常用药、两台显示器的线，别忘了猫砂盆。",
      tags: ["生活"],
      createdAt: hoursAgo(9 * 24),
      updatedAt: hoursAgo(8 * 24),
    },
  ];
}

/** 记录 Tab 的演示对话历史（04 §3.4）。 */
export function previewChatHistory(): ChatHistoryEntry[] {
  const now = nowSeconds();
  const hoursAgo = (hours: number) => now - hours * 3600;

  return [
    {
      id: "preview-chat-1",
      prompt: "帮我把这段会议记录整理成三条待办",
      response: "1) 周三前给出首页改版方案；2) 周五同步季度复盘；3) 下周一前补齐埋点。",
      createdAt: hoursAgo(1),
    },
    {
      id: "preview-chat-2",
      prompt: "SQLite 的 FTS5 能不能搜中文？",
      response: "可以，默认 tokenizer 是 unicode61，中文需要按字或自定义分词器处理。",
      createdAt: hoursAgo(3 * 24),
    },
    {
      id: "preview-chat-3",
      prompt: "搬家前两周该准备什么？",
      response: "先列清单：证件与合同、常用药、易碎品单独打包，最后留一个「第一天」箱子。",
      createdAt: hoursAgo(12 * 24),
    },
  ];
}
