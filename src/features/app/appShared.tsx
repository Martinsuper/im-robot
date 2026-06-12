import { CSSProperties, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { emit, listen, UnlistenFn } from "@tauri-apps/api/event";
import { Live2DCharacterPet } from "./Live2DCharacterPet";

const isTauriRuntime = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
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

const robotCatFrameByMode = {
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

export type PetVisualStyle = "lumi" | "custom" | "classic" | "character";
export type Live2DModelId =
  | "official-hiyori"
  | "official-haru"
  | "official-wanko"
  | "official-natori"
  | "official-ren"
  | "official-rice"
  | "official-mark"
  | "official-mao"
  | "official-epsilon"
  | "official-miara";

export const petVisualStyleStorageKey = "piko-pet-visual-style";
export const customPetImageStorageKey = "piko-custom-pet-image-path";
export const live2dModelStorageKey = "piko-live2d-model-id";
export const live2dOfficialMigrationStorageKey = "piko-live2d-official-model-migrated";
export const defaultPetVisualStyle: PetVisualStyle = "character";
export const defaultLive2DModelId: Live2DModelId = "official-hiyori";

export const petVisualStyleOptions: Array<{ label: string; value: PetVisualStyle }> = [
  { label: "机甲猫", value: "lumi" },
  { label: "Live2D 官方模型", value: "character" },
  { label: "自定义图片", value: "custom" },
  { label: "Piko 经典兜底", value: "classic" },
];

export const live2dModelOptions: Array<{
  label: string;
  value: Live2DModelId;
  profileUrl: string;
  enabled: boolean;
  note: string;
}> = [
  {
    label: "Hiyori",
    value: "official-hiyori",
    profileUrl: "/live2d/profiles/official-hiyori.profile.json",
    enabled: true,
    note: "官方 WebSamples 已内置",
  },
  {
    label: "Wanko",
    value: "official-wanko",
    profileUrl: "/live2d/profiles/official-wanko.profile.json",
    enabled: true,
    note: "官方 WebSamples 已内置",
  },
  {
    label: "Haru",
    value: "official-haru",
    profileUrl: "/live2d/profiles/official-haru.profile.json",
    enabled: true,
    note: "官方 WebSamples 已内置",
  },
  {
    label: "Natori",
    value: "official-natori",
    profileUrl: "/live2d/profiles/official-natori.profile.json",
    enabled: true,
    note: "官方 WebSamples 已内置",
  },
  {
    label: "Ren",
    value: "official-ren",
    profileUrl: "/live2d/profiles/official-ren.profile.json",
    enabled: true,
    note: "官方 WebSamples 已内置",
  },
  {
    label: "Rice",
    value: "official-rice",
    profileUrl: "/live2d/profiles/official-rice.profile.json",
    enabled: true,
    note: "官方 WebSamples 已内置",
  },
  {
    label: "Mark",
    value: "official-mark",
    profileUrl: "/live2d/profiles/official-mark.profile.json",
    enabled: true,
    note: "官方 WebSamples 已内置",
  },
  {
    label: "Mao",
    value: "official-mao",
    profileUrl: "/live2d/profiles/official-mao.profile.json",
    enabled: true,
    note: "当前已内置",
  },
  {
    label: "Epsilon",
    value: "official-epsilon",
    profileUrl: "/live2d/profiles/official-epsilon.profile.json",
    enabled: false,
    note: "需从 Live2D 官方 Sample Data 下载后启用",
  },
  {
    label: "Miara",
    value: "official-miara",
    profileUrl: "/live2d/profiles/official-miara.profile.json",
    enabled: false,
    note: "需从 Live2D 官方 Sample Data 下载后启用",
  },
];

export function getPetVisualStyle(): PetVisualStyle {
  if (typeof window === "undefined") return defaultPetVisualStyle;
  if (window.localStorage.getItem(live2dOfficialMigrationStorageKey) !== "3") {
    window.localStorage.setItem(live2dOfficialMigrationStorageKey, "3");
    window.localStorage.setItem(petVisualStyleStorageKey, defaultPetVisualStyle);
    window.localStorage.setItem(live2dModelStorageKey, defaultLive2DModelId);
    return defaultPetVisualStyle;
  }
  const stored = window.localStorage.getItem(petVisualStyleStorageKey);
  if (stored === "custom" && !getCustomPetImagePath()) return "classic";
  if (petVisualStyleOptions.some((option) => option.value === stored)) return stored as PetVisualStyle;
  if (stored) {
    window.localStorage.setItem(petVisualStyleStorageKey, defaultPetVisualStyle);
  }
  return defaultPetVisualStyle;
}

export function setPetVisualStyle(style: PetVisualStyle) {
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

export function getLive2DModelId(): Live2DModelId {
  if (typeof window === "undefined") return defaultLive2DModelId;
  const stored = window.localStorage.getItem(live2dModelStorageKey);
  const option = live2dModelOptions.find((item) => item.value === stored && item.enabled);
  if (option) return option.value;
  if (stored) window.localStorage.setItem(live2dModelStorageKey, defaultLive2DModelId);
  return defaultLive2DModelId;
}

export function setLive2DModelId(modelId: Live2DModelId) {
  window.localStorage.setItem(live2dModelStorageKey, modelId);
  window.dispatchEvent(new CustomEvent<Live2DModelId>("piko-live2d-model-changed", { detail: modelId }));
  if (isTauriRuntime) {
    void emit("piko-live2d-model-changed", modelId);
  }
}

export function getLive2DProfileUrl(modelId = getLive2DModelId()) {
  return live2dModelOptions.find((option) => option.value === modelId)?.profileUrl ?? live2dModelOptions[0].profileUrl;
}

export function getNextLive2DModelId(modelId = getLive2DModelId()): Live2DModelId {
  const options = live2dModelOptions.filter((option) => option.enabled);
  const index = options.findIndex((option) => option.value === modelId);
  return options[(index + 1) % options.length].value;
}

export function useLive2DModelId() {
  const [modelId, setModelId] = useState<Live2DModelId>(getLive2DModelId);

  useEffect(() => {
    const update = () => setModelId(getLive2DModelId());
    const updateFromEvent = (event: Event) => {
      setModelId((event as CustomEvent<Live2DModelId>).detail ?? getLive2DModelId());
    };
    const updateFromTauriEvent = (event: { payload: Live2DModelId }) => {
      setModelId(event.payload ?? getLive2DModelId());
    };

    window.addEventListener("storage", update);
    window.addEventListener("piko-live2d-model-changed", updateFromEvent);
    let unlistenTauri: UnlistenFn | undefined;
    if (isTauriRuntime) {
      void listen<Live2DModelId>("piko-live2d-model-changed", updateFromTauriEvent).then((unlisten) => {
        unlistenTauri = unlisten;
      });
    }
    return () => {
      window.removeEventListener("storage", update);
      window.removeEventListener("piko-live2d-model-changed", updateFromEvent);
      unlistenTauri?.();
    };
  }, []);

  return modelId;
}

export function usePetVisualStyle() {
  const [style, setStyle] = useState<PetVisualStyle>(getPetVisualStyle);

  useEffect(() => {
    const update = () => setStyle(getPetVisualStyle());
    const updateFromEvent = (event: Event) => {
      setStyle((event as CustomEvent<PetVisualStyle>).detail ?? getPetVisualStyle());
    };
    const updateFromTauriEvent = (event: { payload: PetVisualStyle }) => {
      setStyle(event.payload ?? getPetVisualStyle());
    };

    window.addEventListener("storage", update);
    window.addEventListener("piko-pet-visual-style-changed", updateFromEvent);
    let unlistenTauri: UnlistenFn | undefined;
    if (isTauriRuntime) {
      void listen<PetVisualStyle>("piko-pet-visual-style-changed", updateFromTauriEvent).then((unlisten) => {
        unlistenTauri = unlisten;
      });
    }
    return () => {
      window.removeEventListener("storage", update);
      window.removeEventListener("piko-pet-visual-style-changed", updateFromEvent);
      unlistenTauri?.();
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
      setPath(event.payload ?? getCustomPetImagePath());
    };

    window.addEventListener("storage", update);
    window.addEventListener("piko-custom-pet-image-changed", updateFromEvent);
    let unlistenTauri: UnlistenFn | undefined;
    if (isTauriRuntime) {
      void listen<string>("piko-custom-pet-image-changed", updateFromTauriEvent).then((unlisten) => {
        unlistenTauri = unlisten;
      });
    }
    return () => {
      window.removeEventListener("storage", update);
      window.removeEventListener("piko-custom-pet-image-changed", updateFromEvent);
      unlistenTauri?.();
    };
  }, []);

  return path;
}

export function useCustomPetImageUrl() {
  const path = useCustomPetImagePath();
  return path ? convertFileSrc(path) : "";
}

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

function getRobotCatFrame(mode: keyof typeof petSpriteStates, emotion: string, reaction: string) {
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

export function PetSprite({
  mode = "idle",
  emotion = "neutral",
  reaction = "none",
  compact = false,
  mouseDelta,
}: {
  mode?: keyof typeof petSpriteStates;
  emotion?: string;
  reaction?: string;
  compact?: boolean;
  mouseDelta?: { x: number; y: number };
}) {
  const sprite = petSpriteStates[mode];
  const visualStyle = usePetVisualStyle();
  const live2dModelId = useLive2DModelId();
  const customPetImageUrl = useCustomPetImageUrl();
  const effectiveVisualStyle = visualStyle === "custom" && !customPetImageUrl ? "classic" : visualStyle;
  const robotCatFrame = getRobotCatFrame(mode, emotion, reaction);
  const style = {
    "--sprite-row": sprite.row,
    "--sprite-frames": sprite.frames,
    "--sprite-duration": `${sprite.duration}ms`,
    "--robot-cat-col": robotCatFrame % 4,
    "--robot-cat-row": Math.floor(robotCatFrame / 4),
    "--look-x": mouseDelta ? `${mouseDelta.x * 6}px` : "0px",
    "--look-y": mouseDelta ? `${mouseDelta.y * 4}px` : "0px",
    "--eye-x": mouseDelta ? `${mouseDelta.x * 5}px` : "0px",
    "--eye-y": mouseDelta ? `${mouseDelta.y * 4}px` : "0px",
    "--pet-tilt": mouseDelta ? `${mouseDelta.x * 3}deg` : "0deg",
    "--custom-pet-image": customPetImageUrl ? `url("${customPetImageUrl}")` : "none",
  } as CSSProperties;

  if (effectiveVisualStyle === "classic") {
    return (
      <span className={`pet-sprite-frame pet-sprite-frame--classic${compact ? " pet-sprite-frame--compact" : ""}`}>
        <span className="pet-sprite" style={style} />
      </span>
    );
  }

  if (effectiveVisualStyle === "lumi") {
    return (
      <span
        className={`pet-sprite-frame pet-sprite-frame--robot-cat${compact ? " pet-sprite-frame--compact" : ""}`}
        style={style}
      >
        <span
          className={`robot-cat-sprite robot-cat-sprite--${mode} robot-cat-sprite--emotion-${emotion} robot-cat-sprite--reaction-${reaction}`}
          aria-hidden="true"
        >
          <span className="robot-cat-glow" />
          <span className="robot-cat-image" />
          <span className="robot-cat-shadow" />
        </span>
      </span>
    );
  }

  if (effectiveVisualStyle === "character") {
    return (
      <span
        className={`pet-sprite-frame pet-sprite-frame--character${compact ? " pet-sprite-frame--compact" : ""}`}
        style={style}
      >
        <Live2DCharacterPet
          key={live2dModelId}
          mode={mode}
          emotion={emotion}
          reaction={reaction}
          compact={compact}
          mouseDelta={mouseDelta}
          modelId={live2dModelId}
          profileUrl={getLive2DProfileUrl(live2dModelId)}
        />
      </span>
    );
  }

  if (effectiveVisualStyle === "custom" && customPetImageUrl) {
    return (
      <span
        className={`pet-sprite-frame pet-sprite-frame--custom${compact ? " pet-sprite-frame--compact" : ""}`}
        style={style}
      >
        <span
          className={`custom-pet-sprite custom-pet-sprite--${mode} custom-pet-sprite--emotion-${emotion} custom-pet-sprite--reaction-${reaction}`}
          aria-hidden="true"
        >
          <span className="custom-pet-glow" />
          <span className="custom-pet-image" />
          <span className="custom-pet-shadow" />
        </span>
      </span>
    );
  }

  return (
    <span className={`pet-sprite-frame pet-sprite-frame--classic${compact ? " pet-sprite-frame--compact" : ""}`}>
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
