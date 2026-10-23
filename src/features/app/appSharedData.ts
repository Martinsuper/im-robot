import { convertFileSrc } from "@tauri-apps/api/core";
import { emit,listen } from "@tauri-apps/api/event";
import { useEffect,useState } from "react";
import type {
AiSettings,
AppSettings,
AttachmentAction,
CalendarEvent,
FocusSnapshot,
PanelTab,
QuietMode,
ReminderRepeat,
TypingStatsToday,
WorkRhythmState,
} from "../../types/appTypes";
import { disposeAsyncSubscriptions } from "../../lib/eventSubscription";
import { isTauriRuntime } from "./appRuntime";

export { isTauriRuntime };

export const petSpriteStates = {
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

export const robotCatFrameByMode = {
  idle: 1,
  listening: 4,
  thinking: 2,
  speaking: 6,
  working: 2,
  success: 7,
  confirming: 2,
  resting: 3,
  error: 0,
} satisfies Record<keyof typeof petSpriteStates, number>;


export type PetVisualStyle = "lumi" | "custom" | "classic";


export const petVisualStyleStorageKey = "piko-pet-visual-style";

export const customPetImageStorageKey = "piko-custom-pet-image-path";

export const defaultPetVisualStyle: PetVisualStyle = "classic";


export const petVisualStyleOptions: Array<{ label: string; labelKey: string; value: PetVisualStyle }> = [
  { label: "机甲猫", labelKey: "app.petStyle.lumi", value: "lumi" },
  { label: "自定义图片", labelKey: "app.petStyle.custom", value: "custom" },
  { label: "经典 Piko", labelKey: "app.petStyle.classic", value: "classic" },
];


export function resolvePetVisualStyle(value: unknown, hasCustomImage = Boolean(getCustomPetImagePath())): PetVisualStyle {
  if (value === "custom" && !hasCustomImage) return defaultPetVisualStyle;
  return petVisualStyleOptions.some((option) => option.value === value)
    ? value as PetVisualStyle
    : defaultPetVisualStyle;
}


export function getPetVisualStyle(): PetVisualStyle {
  if (typeof window === "undefined") return defaultPetVisualStyle;
  const stored = window.localStorage.getItem(petVisualStyleStorageKey);
  const style = resolvePetVisualStyle(stored);
  if (stored !== style) window.localStorage.setItem(petVisualStyleStorageKey, style);
  return style;
}


export function setPetVisualStyle(value: PetVisualStyle) {
  const style = resolvePetVisualStyle(value);
  window.localStorage.setItem(petVisualStyleStorageKey, style);
  window.dispatchEvent(new CustomEvent<PetVisualStyle>("piko-pet-visual-style-changed", { detail: style }));
  if (isTauriRuntime) {
    void emit("piko-pet-visual-style-changed", style);
  }
}


export function getCustomPetImagePath() {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(customPetImageStorageKey) ?? "";
}


export function setCustomPetImagePath(path: string) {
  window.localStorage.setItem(customPetImageStorageKey, path);
  window.dispatchEvent(new CustomEvent<string>("piko-custom-pet-image-changed", { detail: path }));
  if (isTauriRuntime) {
    void emit("piko-custom-pet-image-changed", path);
  }
}


export function clearCustomPetImagePath() {
  window.localStorage.removeItem(customPetImageStorageKey);
  if (window.localStorage.getItem(petVisualStyleStorageKey) === "custom") {
    setPetVisualStyle(defaultPetVisualStyle);
  }
  window.dispatchEvent(new CustomEvent<string>("piko-custom-pet-image-changed", { detail: "" }));
  if (isTauriRuntime) {
    void emit("piko-custom-pet-image-changed", "");
  }
}


export function getAvailablePetVisualStyleOptions(hasCustomImage = Boolean(getCustomPetImagePath())) {
  return petVisualStyleOptions.filter((option) => option.value !== "custom" || hasCustomImage);
}


export function getNextPetVisualStyle(
  style = getPetVisualStyle(),
  hasCustomImage = Boolean(getCustomPetImagePath()),
): PetVisualStyle {
  const options = getAvailablePetVisualStyleOptions(hasCustomImage);
  const index = options.findIndex((option) => option.value === style);
  return options[(index + 1) % options.length].value;
}


export function usePetVisualStyle() {
  const [style, setStyle] = useState<PetVisualStyle>(getPetVisualStyle);

  useEffect(() => {
    const update = () => setStyle(getPetVisualStyle());
    const updateFromTauriEvent = (event: { payload: PetVisualStyle }) => {
      // 同步持久化值，避免重开窗口后回到旧形象。
      window.localStorage.setItem(petVisualStyleStorageKey, resolvePetVisualStyle(event.payload));
      update();
    };

    window.addEventListener("storage", update);
    window.addEventListener("piko-pet-visual-style-changed", update);
    window.addEventListener("piko-custom-pet-image-changed", update);
    const dispose = disposeAsyncSubscriptions(isTauriRuntime
      ? [listen<PetVisualStyle>("piko-pet-visual-style-changed", updateFromTauriEvent)]
      : []);
    update();
    return () => {
      window.removeEventListener("storage", update);
      window.removeEventListener("piko-pet-visual-style-changed", update);
      window.removeEventListener("piko-custom-pet-image-changed", update);
      dispose();
    };
  }, []);

  return style;
}


export function useCustomPetImagePath() {
  const [path, setPath] = useState(getCustomPetImagePath);

  useEffect(() => {
    const update = () => setPath(getCustomPetImagePath());
    const updateFromEvent = (event: Event) => {
      setPath((event as CustomEvent<string>).detail ?? getCustomPetImagePath());
    };
    const updateFromTauriEvent = (event: { payload: string }) => {
      window.localStorage.setItem(customPetImageStorageKey, event.payload ?? "");
      update();
    };

    window.addEventListener("storage", update);
    window.addEventListener("piko-custom-pet-image-changed", updateFromEvent);
    const dispose = disposeAsyncSubscriptions(isTauriRuntime
      ? [listen<string>("piko-custom-pet-image-changed", updateFromTauriEvent)]
      : []);
    update();
    return () => {
      window.removeEventListener("storage", update);
      window.removeEventListener("piko-custom-pet-image-changed", updateFromEvent);
      dispose();
    };
  }, []);

  return path;
}


export function useCustomPetImageUrl() {
  const path = useCustomPetImagePath();
  return path ? (isTauriRuntime ? convertFileSrc(path) : path) : "";
}

export function formatCurrentTime() {
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

export function getRobotCatFrame(mode: keyof typeof petSpriteStates, emotion: string, reaction: string) {
  if (reaction === "celebrate" || mode === "success") return 7;
  if (reaction === "greet") return 6;
  if (mode === "resting" || emotion === "sleepy") return 3;
  if (mode === "error" || emotion === "worried") return 0;
  if (mode === "listening" || emotion === "surprised") return 4;
  if (mode === "thinking" || mode === "working" || mode === "confirming") return 2;
  if (emotion === "excited" || emotion === "playful") return 5;
  if (emotion === "happy") return 7;
  if (emotion === "curious" || emotion === "thoughtful") return 1;
  return robotCatFrameByMode[mode];
}


export function countCalendarConflicts(events: CalendarEvent[], startAt: number, endAt: number) {
  return events.filter((event) => event.startAt < endAt && startAt < event.endAt).length;
}


export const defaultAiSettings: AiSettings = {
  provider: "ollama",
  baseUrl: "http://localhost:11434/v1",
  model: "",
  speechModel: "sense-voice",
  temperature: 0.7,
  timeoutSeconds: 120,
};


export const defaultAppSettings: AppSettings = {
  quietMode: "balanced",
  companionName: "Piko",
  theme: "sage",
  language: "zh-CN",
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
  agentAutoApproveCommands: false,
  globalShortcut: "CmdOrCtrl+Shift+Space",
  onboardingCompleted: false,
  onboardingVersion: "",
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


// provider 预设已收敛到 ./providerPresets（唯一来源，引导页与设置页共用）。
// 这里保留同名导出，避免一次性改动所有调用点。
export {
findProviderPreset,
providerPresets as providerOptions,
type ProviderPreset
} from "./providerPresets";


export const quietModeOptions: Array<{ label: string; labelKey: string; value: QuietMode }> = [
  { label: "活泼", labelKey: "app.quietMode.active", value: "active" },
  { label: "平衡", labelKey: "app.quietMode.balanced", value: "balanced" },
  { label: "极简", labelKey: "app.quietMode.minimal", value: "minimal" },
];


export const panelTabOptions: Array<{ label: string; value: PanelTab }> = [
  { label: "今天", value: "today" },
  { label: "记录", value: "records" },
  { label: "设置", value: "settings" },
];


export const reminderRepeatOptions: Array<{ label: string; labelKey: string; value: ReminderRepeat }> = [
  { label: "仅一次", labelKey: "app.repeat.none", value: "none" },
  { label: "每天", labelKey: "app.repeat.daily", value: "daily" },
  { label: "每周", labelKey: "app.repeat.weekly", value: "weekly" },
  { label: "工作日", labelKey: "app.repeat.weekdays", value: "weekdays" },
];


export function reminderRepeatLabel(repeat: ReminderRepeat, translate?: (key: string, fallback?: string) => string) {
  const option = reminderRepeatOptions.find((item) => item.value === repeat);
  if (!option) return translate ? translate("app.repeat.none", "仅一次") : "仅一次";
  return translate ? translate(option.labelKey, option.label) : option.label;
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
