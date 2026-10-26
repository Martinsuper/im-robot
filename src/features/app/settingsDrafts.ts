import type { Theme } from "../../types/appTypes";

export interface PreferencesDraft {
  companionName: string;
  theme: Theme;
  sensingPaused: boolean;
}

export interface WorkRhythmDraft {
  breakRemindersEnabled: boolean;
  breakReminderIntervalMinutes: number;
  breakReminderCooldownMinutes: number;
  breakReminderQuietHoursEnabled: boolean;
  breakReminderQuietHoursStart: string;
  breakReminderQuietHoursEnd: string;
}

export const defaultPreferencesDraft: PreferencesDraft = {
  companionName: "Piko",
  theme: "sage",
  sensingPaused: false,
};

export const defaultWorkRhythmDraft: WorkRhythmDraft = {
  breakRemindersEnabled: true,
  breakReminderIntervalMinutes: 45,
  breakReminderCooldownMinutes: 30,
  breakReminderQuietHoursEnabled: false,
  breakReminderQuietHoursStart: "22:00",
  breakReminderQuietHoursEnd: "08:00",
};

/** 与偏好设置相关的服务端字段，用于把 AppSettings 收敛成草稿。 */
export interface PreferencesSource {
  companionName: string;
  theme: Theme;
  sensingPaused: boolean;
}

export interface WorkRhythmSource {
  breakRemindersEnabled: boolean;
  breakReminderIntervalMinutes: number;
  breakReminderCooldownMinutes: number;
  breakReminderQuietHoursEnabled: boolean;
  breakReminderQuietHoursStart: string;
  breakReminderQuietHoursEnd: string;
}

const CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 镜像服务端校验（`src-tauri/src/lib.rs` 的 `validate_work_rhythm_preferences`）。
 *
 * Why 需要镜像：即时保存会在用户输入过程中触发。若把空输入框（`Number("") === 0`）
 * 或半截数字直接提交，服务端必然拒绝，用户就会看到一串「保存失败」噪音。本地先挡一层，
 * 非法值只留在输入框里，不产生请求。
 */
export function isWorkRhythmDraftValid(draft: WorkRhythmDraft): boolean {
  return (
    Number.isFinite(draft.breakReminderIntervalMinutes) &&
    draft.breakReminderIntervalMinutes >= 15 &&
    draft.breakReminderIntervalMinutes <= 240 &&
    Number.isFinite(draft.breakReminderCooldownMinutes) &&
    draft.breakReminderCooldownMinutes >= 5 &&
    draft.breakReminderCooldownMinutes <= 240 &&
    CLOCK_PATTERN.test(draft.breakReminderQuietHoursStart) &&
    CLOCK_PATTERN.test(draft.breakReminderQuietHoursEnd)
  );
}

export function toPreferencesDraft(settings: PreferencesSource): PreferencesDraft {
  return {
    companionName: settings.companionName,
    theme: settings.theme,
    sensingPaused: settings.sensingPaused,
  };
}

export function toWorkRhythmDraft(settings: WorkRhythmSource): WorkRhythmDraft {
  return {
    breakRemindersEnabled: settings.breakRemindersEnabled,
    breakReminderIntervalMinutes: settings.breakReminderIntervalMinutes,
    breakReminderCooldownMinutes: settings.breakReminderCooldownMinutes,
    breakReminderQuietHoursEnabled: settings.breakReminderQuietHoursEnabled,
    breakReminderQuietHoursStart: settings.breakReminderQuietHoursStart,
    breakReminderQuietHoursEnd: settings.breakReminderQuietHoursEnd,
  };
}
