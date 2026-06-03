export interface AiSettings {
  provider: string;
  baseUrl: string;
  model: string;
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
}

export interface ModelInfo {
  id: string;
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

export interface DesktopItem {
  name: string;
  path: string;
  itemType: "file" | "folder" | "shortcut";
  category: "images" | "documents" | "archives" | "code" | "shortcuts" | "other";
}

export interface DesktopOrganizeMove {
  from: string;
  to: string;
  category: string;
}

export interface DesktopOrganizePlan {
  id: string;
  desktopDir: string;
  plannedMoves: DesktopOrganizeMove[];
  createdFolders: string[];
  skippedItems: string[];
  createdAt: number;
  status: "draft" | "confirmed" | "executing" | "completed" | "failed";
}

export interface DesktopOrganizeResult {
  planId: string;
  movedCount: number;
  skippedCount: number;
  createdFolders: string[];
  errors: string[];
}

export type AttachmentAction = "summarize" | "translate" | "explain";
export type Theme = "sage" | "blue" | "peach";
export type PanelTab = "companion" | "settings" | "reminders" | "calendar" | "history" | "memory" | "about";
export type ReminderRepeat = "none" | "daily" | "weekly" | "weekdays";

export interface OnboardingStatus {
  required: boolean;
  completed: boolean;
  version: string;
}

export type PetVisualEvent =
  | { type: "attachment-ready" }
  | { type: "reminder-fired"; message: string }
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
