import { describe, expect, it } from "vitest";
import {
  defaultWorkRhythmDraft,
  isWorkRhythmDraftValid,
  toPreferencesDraft,
  toWorkRhythmDraft,
} from "./settingsDrafts";

describe("isWorkRhythmDraftValid", () => {
  it("默认值是合法的", () => {
    expect(isWorkRhythmDraftValid(defaultWorkRhythmDraft)).toBe(true);
  });

  it("拒绝输入框清空造成的 NaN 与 0", () => {
    expect(isWorkRhythmDraftValid({ ...defaultWorkRhythmDraft, breakReminderIntervalMinutes: Number("") })).toBe(false);
    expect(isWorkRhythmDraftValid({ ...defaultWorkRhythmDraft, breakReminderIntervalMinutes: 0 })).toBe(false);
    expect(isWorkRhythmDraftValid({ ...defaultWorkRhythmDraft, breakReminderCooldownMinutes: Number("") })).toBe(false);
  });

  it("边界值与服务端一致：间隔 15~240、冷却 5~240", () => {
    expect(isWorkRhythmDraftValid({ ...defaultWorkRhythmDraft, breakReminderIntervalMinutes: 15 })).toBe(true);
    expect(isWorkRhythmDraftValid({ ...defaultWorkRhythmDraft, breakReminderIntervalMinutes: 240 })).toBe(true);
    expect(isWorkRhythmDraftValid({ ...defaultWorkRhythmDraft, breakReminderIntervalMinutes: 14 })).toBe(false);
    expect(isWorkRhythmDraftValid({ ...defaultWorkRhythmDraft, breakReminderIntervalMinutes: 241 })).toBe(false);
    expect(isWorkRhythmDraftValid({ ...defaultWorkRhythmDraft, breakReminderCooldownMinutes: 5 })).toBe(true);
    expect(isWorkRhythmDraftValid({ ...defaultWorkRhythmDraft, breakReminderCooldownMinutes: 4 })).toBe(false);
  });

  it("校验免打扰时段的 HH:mm 格式", () => {
    expect(isWorkRhythmDraftValid({ ...defaultWorkRhythmDraft, breakReminderQuietHoursStart: "00:00" })).toBe(true);
    expect(isWorkRhythmDraftValid({ ...defaultWorkRhythmDraft, breakReminderQuietHoursStart: "23:59" })).toBe(true);
    expect(isWorkRhythmDraftValid({ ...defaultWorkRhythmDraft, breakReminderQuietHoursStart: "24:00" })).toBe(false);
    expect(isWorkRhythmDraftValid({ ...defaultWorkRhythmDraft, breakReminderQuietHoursEnd: "8:00" })).toBe(false);
    expect(isWorkRhythmDraftValid({ ...defaultWorkRhythmDraft, breakReminderQuietHoursEnd: "" })).toBe(false);
  });
});

describe("服务端设置 → 草稿", () => {
  it("只取关心字段，不把整个 AppSettings 泄进草稿", () => {
    const settings = {
      companionName: "小皮",
      theme: "peach" as const,
      sensingPaused: true,
      breakRemindersEnabled: false,
      breakReminderIntervalMinutes: 60,
      breakReminderCooldownMinutes: 15,
      breakReminderQuietHoursEnabled: true,
      breakReminderQuietHoursStart: "21:30",
      breakReminderQuietHoursEnd: "07:30",
    };
    expect(toPreferencesDraft(settings)).toEqual({ companionName: "小皮", theme: "peach", sensingPaused: true });
    expect(toWorkRhythmDraft(settings)).toEqual({
      breakRemindersEnabled: false,
      breakReminderIntervalMinutes: 60,
      breakReminderCooldownMinutes: 15,
      breakReminderQuietHoursEnabled: true,
      breakReminderQuietHoursStart: "21:30",
      breakReminderQuietHoursEnd: "07:30",
    });
  });
});
