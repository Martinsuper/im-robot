export interface AiSettings {
  provider: string;
  baseUrl: string;
  model: string;
  speechModel: string;
  temperature: number;
  timeoutSeconds: number;
}

export type QuietMode = "active" | "balanced" | "minimal";

export interface AppSettings {
  quietMode: QuietMode;
  companionName: string;
  theme: Theme;
  sensingPaused: boolean;
  breakRemindersEnabled: boolean;
  breakReminderIntervalMinutes: number;
  breakReminderCooldownMinutes: number;
  breakReminderQuietHoursEnabled: boolean;
  breakReminderQuietHoursStart: string;
  breakReminderQuietHoursEnd: string;
  ai: AiSettings;
  hasApiKey: boolean;
  htmlPreviewEnabled: boolean;
  /** 全局快捷键（打开对话窗口）。格式如 CmdOrCtrl+Shift+Space。 */
  globalShortcut: string;
}

export interface ModelInfo {
  id: string;
}

export interface SpeechModelStatus {
  id: string;
  name: string;
  fileName: string;
  downloadUrl: string;
  downloaded: boolean;
  byteSize: number;
  path?: string;
}

export interface SpeechModelDownloadProgress {
  modelId: string;
  downloadedBytes: number;
  totalBytes?: number;
  percent?: number;
  completed: boolean;
}

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  releaseUrl: string;
  releaseNotes: string | null;
  downloadUrl: string | null;
  assetName: string | null;
}

export interface CalendarSyncStatus {
  platform: string;
  available: boolean;
  lastSync: number | null;
  mappingCount: number;
}

export interface ChatHistoryEntry {
  id: string;
  prompt: string;
  response: string;
  createdAt: number;
}

export interface AttachmentPreview {
  displayName: string;
  byteSize: number;
  charCount: number;
  preview: string;
}

export interface ScreenshotPreview {
  dataUrl: string;
  width: number;
  height: number;
}

export interface CaptureSelection {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Reminder {
  id: string;
  title: string;
  dueAt: number;
  status: "pending" | "triggered";
  repeat: ReminderRepeat;
}

export type MemoCategory = "task" | "idea" | "learning" | "work" | "life" | "reference" | "other";

export interface Memo {
  id: string;
  title: string;
  content: string;
  category: MemoCategory;
  summary: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface MemoSummaryGroup {
  category: MemoCategory;
  count: number;
  latestUpdatedAt: number;
  summary: string;
  topTags: string[];
}

/** 提醒与日程的统一模型（R1）。后端存储在 schedule-items.json。 */
export type ScheduleKind = "reminder" | "event";

export type ScheduleStatus = "pending" | "triggered" | "done";

export interface ScheduleItem {
  id: string;
  kind: ScheduleKind;
  title: string;
  /** 时间线排序与展示的唯一时间起点：提醒取 dueAt，日程取 startAt。 */
  startAt: number;
  /** 仅日程有结束时间。 */
  endAt?: number;
  /** 仅提醒。 */
  status?: ScheduleStatus;
  /** 仅提醒。 */
  repeat?: ReminderRepeat;
  location?: string;
  notes?: string;
  /** 来源标记：user / migrated:xxx。用于排查，不面向用户展示。 */
  source?: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  startAt: number;
  endAt: number;
  location?: string;
  notes?: string;
}

export interface InstalledPlugin {
  manifest: {
    id: string;
    name: string;
    version: string;
  };
  executable: boolean;
  status: string;
}

export type AttachmentAction = "summarize" | "translate" | "explain";
export type Theme = "sage" | "blue" | "peach";
export type PanelTab = "today" | "records" | "settings";
export type ReminderRepeat = "none" | "daily" | "weekly" | "weekdays";

export interface OnboardingStatus {
  required: boolean;
  completed: boolean;
  version: string;
}

export type PetVisualEvent =
  | { type: "attachment-ready" }
  | { type: "reminder-fired"; message: string }
  | { type: "calendar-event-due"; message: string }
  | { type: "ambient-nudge" }
  | { type: "break-reminder"; message: string }
  | { type: "idle-started" }
  | { type: "idle-ended" }
  | { type: "focus-started" }
  | { type: "focus-completed" };

export interface FocusSnapshot {
  status: "idle" | "running" | "paused";
  kind: "focus" | "break";
  remainingSeconds: number;
  todayMinutes: number;
}

export interface TypingStatsToday {
  date: string;
  typedCharacters: number;
  typingSeconds: number;
  updatedAt: number;
}

export interface WorkRhythmState {
  date: string;
  isIdle: boolean;
  idleSeconds: number;
  activeAppCategory: "ide" | "browser" | "video_conference" | "game" | "other";
  typingCharactersToday: number;
  typingSecondsToday: number;
  focusStatus: "idle" | "running" | "paused";
  focusKind: "focus" | "break";
  focusRemainingSeconds: number;
}
