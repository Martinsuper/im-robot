import { useEffect, useRef, useState } from "react";
import { useAutoSave } from "../../hooks/useAutoSave";
import { useStableEvent } from "../../hooks/useStableEvent";
import type { AppSettings } from "../../types/appTypes";
import { defaultAppSettings } from "../app/appShared";
import { runCommand } from "../app/appRuntime";
import {
  isWorkRhythmDraftValid,
  toPreferencesDraft,
  toWorkRhythmDraft,
  type PreferencesDraft,
  type WorkRhythmDraft,
} from "./settingsDrafts";

export function usePreferenceDrafts(settings: AppSettings) {
  const preferencesSave = useAutoSave(400, "preferences");
  const rhythmSave = useAutoSave(400, "work-rhythm");
  // 偏好与休息提醒改为「草稿 + 已保存基线」两个来源：
  // 只有服务端返回值会更新基线，用户改动只动草稿，自动保存因此不会误判。
  const [preferences, setPreferences] = useState<PreferencesDraft>(() =>
    toPreferencesDraft(settings),
  );
  const preferencesRef = useRef(preferences);
  const savedPreferencesRef = useRef(preferences);
  const { companionName, theme, sensingPaused } = preferences;
  const [workRhythm, setWorkRhythm] = useState<WorkRhythmDraft>(() =>
    toWorkRhythmDraft(settings),
  );
  const workRhythmRef = useRef(workRhythm);
  const savedWorkRhythmRef = useRef(workRhythm);
  const {
    breakRemindersEnabled,
    breakReminderIntervalMinutes,
    breakReminderCooldownMinutes,
    breakReminderQuietHoursEnabled,
    breakReminderQuietHoursStart,
    breakReminderQuietHoursEnd,
  } = workRhythm;

  /**
   * 服务端返回的设置是唯一权威值（00 §5.8）：只有这里会推进「已保存基线」。
   *
   * 不调 `applyServer`：草稿本来就是从同一份 `AppSettings` 收敛出来的，再广播一次
   * 会让 store 重新 publish 同一个对象，从而把上面那条 effect 又唤醒一轮。写入命令
   * 都已在服务端落库，其它 Tab 由 `settings-updated` 事件驱动。
   */
  function applyPreferences(next: AppSettings) {
    const draft = toPreferencesDraft(next);
    savedPreferencesRef.current = draft;
    preferencesRef.current = draft;
    setPreferences(draft);
  }

  function applyWorkRhythm(next: AppSettings) {
    const draft = toWorkRhythmDraft(next);
    savedWorkRhythmRef.current = draft;
    workRhythmRef.current = draft;
    setWorkRhythm(draft);
  }

  function updatePreferences(patch: Partial<PreferencesDraft>) {
    const next = { ...preferencesRef.current, ...patch };
    preferencesRef.current = next;
    setPreferences(next);
    // update_preferences 是整组替换，必须带上组内全部字段，不能只传改动的那个。
    preferencesSave.schedule(
      () =>
        runCommand(
          "update_preferences",
          { input: next },
          {
            ...defaultAppSettings,
            ...next,
            ai: settings.ai,
          },
        ) as Promise<AppSettings>,
      {
        rollback: () => {
          const saved = savedPreferencesRef.current;
          preferencesRef.current = saved;
          setPreferences(saved);
        },
        onPersisted: (value) => {
          savedPreferencesRef.current = toPreferencesDraft(value);
        },
        onSuccess: applyPreferences,
        errorFallback: "个性化设置保存失败，请重试。",
      },
    );
  }

  function updateWorkRhythm(patch: Partial<WorkRhythmDraft>) {
    const next = { ...workRhythmRef.current, ...patch };
    workRhythmRef.current = next;
    setWorkRhythm(next);
    if (!isWorkRhythmDraftValid(next)) {
      rhythmSave.cancel();
      return;
    }
    rhythmSave.schedule(
      () =>
        runCommand(
          "update_work_rhythm_preferences",
          { input: next },
          {
            ...defaultAppSettings,
            ...next,
            ai: settings.ai,
          },
        ) as Promise<AppSettings>,
      {
        rollback: () => {
          const saved = savedWorkRhythmRef.current;
          workRhythmRef.current = saved;
          setWorkRhythm(saved);
        },
        onPersisted: (value) => {
          savedWorkRhythmRef.current = toWorkRhythmDraft(value);
        },
        onSuccess: applyWorkRhythm,
        errorFallback: "休息提醒设置保存失败，请重试。",
      },
    );
  }

  const syncSettings = useStableEvent((next: AppSettings) => {
    if (preferencesRef.current === savedPreferencesRef.current)
      applyPreferences(next);
    if (workRhythmRef.current === savedWorkRhythmRef.current)
      applyWorkRhythm(next);
  });
  useEffect(() => {
    syncSettings(settings);
  }, [settings, syncSettings]);
  return {
    companionName,
    theme,
    sensingPaused,
    breakRemindersEnabled,
    breakReminderIntervalMinutes,
    breakReminderCooldownMinutes,
    breakReminderQuietHoursEnabled,
    breakReminderQuietHoursStart,
    breakReminderQuietHoursEnd,
    updatePreferences,
    updateWorkRhythm,
  };
}
