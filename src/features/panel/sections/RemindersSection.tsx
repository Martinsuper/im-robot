import type { Dispatch, FormEvent, SetStateAction } from "react";
import type { FocusSnapshot, Reminder, ReminderRepeat } from "../../../types/appTypes";
import { useTranslation } from "../../i18n/I18nProvider";
import {
  formatFocusRemaining,
  formatReminderTime,
  reminderRepeatLabel,
  reminderRepeatOptions,
} from "../../app/appShared";

interface RemindersSectionProps {
  className: string;
  focusState: FocusSnapshot;
  focusMinutes: number;
  setFocusMinutes: Dispatch<SetStateAction<number>>;
  updateFocus: (command: string, args?: Record<string, unknown>) => Promise<void>;
  reminders: Reminder[];
  reminderTitle: string;
  setReminderTitle: Dispatch<SetStateAction<string>>;
  reminderDueAt: string;
  setReminderDueAt: Dispatch<SetStateAction<string>>;
  reminderRepeat: ReminderRepeat;
  setReminderRepeat: Dispatch<SetStateAction<ReminderRepeat>>;
  reminderError: string;
  createReminder: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  deleteReminder: (id: string) => Promise<void>;
}

export function RemindersSection({
  className,
  focusState,
  focusMinutes,
  setFocusMinutes,
  updateFocus,
  reminders,
  reminderTitle,
  setReminderTitle,
  reminderDueAt,
  setReminderDueAt,
  reminderRepeat,
  setReminderRepeat,
  reminderError,
  createReminder,
  deleteReminder,
}: RemindersSectionProps) {
  const { t } = useTranslation();
  return (
    <section className={className}>
      <div className="focus-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">FOCUS TIMER</p>
            <h2>{focusState.kind === "break" ? t("panel.focus.breakTitle", "休息倒计时") : t("panel.focus.focusTitle", "专注模式")}</h2>
          </div>
          <strong>{formatFocusRemaining(focusState.remainingSeconds)}</strong>
        </div>
        {focusState.status === "idle" ? (
          <div className="focus-controls">
            <select value={focusMinutes} onChange={(event) => setFocusMinutes(Number(event.currentTarget.value))} aria-label={t("panel.focus.durationLabel", "专注时长")}>
              {[15, 25, 45, 60].map((minutes) => (
                <option key={minutes} value={minutes}>
                  {t("panel.focus.minutesOption", "{minutes} 分钟").replace("{minutes}", String(minutes))}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => void updateFocus("start_focus", { minutes: focusMinutes })}>{t("focus.start", "开始专注")}</button>
            {[5, 10, 15].map((minutes) => (
              <button key={minutes} type="button" onClick={() => void updateFocus("start_break", { minutes })}>
                {t("panel.focus.breakShort", "休息 {minutes}").replace("{minutes}", String(minutes))}
              </button>
            ))}
          </div>
        ) : (
          <div className="focus-controls">
            <button type="button" onClick={() => void updateFocus(focusState.status === "paused" ? "resume_focus" : "pause_focus")}>
              {focusState.status === "paused" ? t("focus.resume", "继续") : t("focus.pause", "暂停")}
            </button>
            <button type="button" onClick={() => void updateFocus("stop_focus")}>{t("panel.focus.stop", "结束")}</button>
          </div>
        )}
      </div>
      <p className="eyebrow">REMINDERS</p>
      <h2>{t("reminders.title", "提醒事项")}</h2>
      <form className="reminder-form" onSubmit={createReminder}>
        <input
          value={reminderTitle}
          onChange={(event) => setReminderTitle(event.currentTarget.value)}
          maxLength={120}
          placeholder={t("panel.reminders.titlePlaceholder", "例如：起来活动一下")}
          aria-label={t("panel.reminders.contentLabel", "提醒内容")}
        />
        <div>
          <input
            type="datetime-local"
            value={reminderDueAt}
            onChange={(event) => setReminderDueAt(event.currentTarget.value)}
            aria-label={t("panel.reminders.timeLabel", "提醒时间")}
          />
          <button type="submit" disabled={!reminderTitle.trim() || !reminderDueAt}>
            {t("panel.reminders.add", "添加")}
          </button>
        </div>
        <select
          value={reminderRepeat}
          onChange={(event) => setReminderRepeat(event.currentTarget.value as ReminderRepeat)}
          aria-label={t("panel.reminders.repeatLabel", "重复规则")}
        >
          {reminderRepeatOptions.map(({ label, labelKey, value }) => (
            <option key={value} value={value}>{t(labelKey, label)}</option>
          ))}
        </select>
      </form>
      {reminderError && <p className="reminder-error">{reminderError}</p>}
      {reminders.length ? (
        <ul className="reminder-list">
          {reminders.map((reminder) => (
            <li key={reminder.id}>
              <div>
                <strong>{reminder.title}</strong>
                <span>
                  {formatReminderTime(reminder.dueAt)} ·{" "}
                  {reminder.status === "triggered" ? t("panel.reminders.triggered", "已提醒") : t("panel.reminders.waiting", "等待中")} ·{" "}
                  {reminderRepeatLabel(reminder.repeat, t)}
                </span>
              </div>
              <button type="button" onClick={() => void deleteReminder(reminder.id)}>
                {t("panel.reminders.delete", "删除")}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-state">{t("panel.reminders.empty", "暂无提醒。")}</p>
      )}
    </section>
  );
}
