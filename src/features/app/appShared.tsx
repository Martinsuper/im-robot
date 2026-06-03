import { CSSProperties, useEffect, useState } from "react";
import type {
  AiSettings,
  AppSettings,
  AttachmentAction,
  CalendarEvent,
  FocusSnapshot,
  DesktopOrganizePlan,
  DesktopOrganizeResult,
  PanelTab,
  QuietMode,
  ReminderRepeat,
  TypingStatsToday,
  WorkRhythmState,
} from "../../types/appTypes";

const petSpriteStates = {
  idle: { row: 0, frames: 6, duration: 5500 },
  listening: { row: 3, frames: 4, duration: 700 },
  thinking: { row: 8, frames: 6, duration: 1030 },
  speaking: { row: 3, frames: 4, duration: 700 },
  working: { row: 7, frames: 6, duration: 820 },
  success: { row: 4, frames: 5, duration: 840 },
  confirming: { row: 6, frames: 6, duration: 1010 },
  resting: { row: 0, frames: 1, duration: 5500 },
  error: { row: 5, frames: 8, duration: 1220 },
};

function formatCurrentTime() {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

export function useCurrentTime() {
  const [currentTime, setCurrentTime] = useState(formatCurrentTime);

  useEffect(() => {
    let timer: number | undefined;

    const updateTime = () => {
      setCurrentTime(formatCurrentTime());
      timer = window.setTimeout(updateTime, 1000 - (Date.now() % 1000));
    };

    timer = window.setTimeout(updateTime, 1000 - (Date.now() % 1000));
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  return currentTime;
}

export function PetSprite({
  mode = "idle",
  compact = false,
}: {
  mode?: keyof typeof petSpriteStates;
  compact?: boolean;
}) {
  const sprite = petSpriteStates[mode];
  const style = {
    "--sprite-row": sprite.row,
    "--sprite-frames": sprite.frames,
    "--sprite-duration": `${sprite.duration}ms`,
  } as CSSProperties;

  return (
    <span className={`pet-sprite-frame${compact ? " pet-sprite-frame--compact" : ""}`}>
      <span className="pet-sprite" style={style} />
    </span>
  );
}

export function countCalendarConflicts(events: CalendarEvent[], startAt: number, endAt: number) {
  return events.filter((event) => event.startAt < endAt && startAt < event.endAt).length;
}

export const defaultAiSettings: AiSettings = {
  provider: "openai-compatible",
  baseUrl: "http://localhost:11434/v1",
  model: "gemma4:e4b",
  temperature: 0.7,
  timeoutSeconds: 120,
};

export const defaultAppSettings: AppSettings = {
  quietMode: "balanced",
  companionName: "Piko",
  theme: "sage",
  sensingPaused: false,
  breakRemindersEnabled: true,
  breakReminderIntervalMinutes: 45,
  breakReminderCooldownMinutes: 30,
  breakReminderQuietHoursEnabled: false,
  breakReminderQuietHoursStart: "22:00",
  breakReminderQuietHoursEnd: "08:00",
  ai: defaultAiSettings,
  hasApiKey: false,
  htmlPreviewEnabled: false,
};

export const defaultFocusSnapshot: FocusSnapshot = {
  status: "idle",
  kind: "focus",
  remainingSeconds: 0,
  todayMinutes: 0,
};

export const defaultTypingStatsToday: TypingStatsToday = {
  date: "",
  typedCharacters: 0,
  typingSeconds: 0,
  updatedAt: 0,
};

export const defaultWorkRhythmState: WorkRhythmState = {
  date: "",
  isIdle: false,
  idleSeconds: 0,
  activeAppCategory: "other",
  typingCharactersToday: 0,
  typingSecondsToday: 0,
  focusStatus: "idle",
  focusKind: "focus",
  focusRemainingSeconds: 0,
};

export const defaultDesktopOrganizePlan: DesktopOrganizePlan = {
  id: "",
  desktopDir: "",
  plannedMoves: [],
  createdFolders: [],
  skippedItems: [],
  createdAt: 0,
  status: "draft",
};

export const defaultDesktopOrganizeResult: DesktopOrganizeResult = {
  planId: "",
  movedCount: 0,
  skippedCount: 0,
  createdFolders: [],
  errors: [],
};

export const providerOptions = [
  { label: "LM Studio", value: "lmstudio", baseUrl: "http://localhost:1234/v1", model: "" },
  { label: "OpenAI Compatible", value: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "gemma4:e4b" },
  { label: "Anthropic Claude", value: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-6" },
  { label: "Google Gemini", value: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash" },
  { label: "DeepSeek", value: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" },
  { label: "通义千问 DashScope", value: "dashscope", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.6-plus" },
];

export const quietModeOptions: Array<{ label: string; value: QuietMode }> = [
  { label: "活泼", value: "active" },
  { label: "平衡", value: "balanced" },
  { label: "极简", value: "minimal" },
];

export const panelTabOptions: Array<{ label: string; value: PanelTab }> = [
  { label: "精灵", value: "companion" },
  { label: "设置", value: "settings" },
  { label: "提醒", value: "reminders" },
  { label: "日程", value: "calendar" },
  { label: "历史", value: "history" },
  { label: "记忆", value: "memory" },
  { label: "关于", value: "about" },
];

export const reminderRepeatOptions: Array<{ label: string; value: ReminderRepeat }> = [
  { label: "仅一次", value: "none" },
  { label: "每天", value: "daily" },
  { label: "每周", value: "weekly" },
  { label: "工作日", value: "weekdays" },
];

export function reminderRepeatLabel(repeat: ReminderRepeat) {
  return reminderRepeatOptions.find((option) => option.value === repeat)?.label ?? "仅一次";
}

export const attachmentActionOptions: Array<{ label: string; value: AttachmentAction }> = [
  { label: "总结", value: "summarize" },
  { label: "翻译", value: "translate" },
  { label: "解释", value: "explain" },
];

export function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

export function defaultReminderTime() {
  const date = new Date(Date.now() + 10 * 60 * 1000);
  date.setSeconds(0, 0);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

export function defaultCalendarStartTime() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setMinutes(0, 0, 0);
  return formatLocalDateTimeInput(date);
}

export function defaultCalendarEndTime() {
  const date = new Date(Date.now() + 2 * 60 * 60 * 1000);
  date.setMinutes(0, 0, 0);
  return formatLocalDateTimeInput(date);
}

export function formatLocalDateTimeInput(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

export function formatReminderTime(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp * 1000);
}

export function formatCalendarRange(startAt: number, endAt: number) {
  return `${formatReminderTime(startAt)} - ${formatReminderTime(endAt)}`;
}

export function formatFocusRemaining(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

export function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (hours > 0) parts.push(`${hours} 小时`);
  parts.push(`${minutes} 分`);
  return parts.join(" ");
}

export function normalizeCaptureSelection(startX: number, startY: number, endX: number, endY: number) {
  return {
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  };
}
