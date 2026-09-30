import type { Dispatch, FormEvent, SetStateAction } from "react";
import type { CalendarEvent, CalendarSyncStatus } from "../../../types/appTypes";
import { formatCalendarRange } from "../../app/appShared";

interface CalendarSectionProps {
  className: string;
  calendarEvents: CalendarEvent[];
  calendarSyncStatus: CalendarSyncStatus;
  calendarSyncNotice: string;
  calendarTitle: string;
  setCalendarTitle: Dispatch<SetStateAction<string>>;
  calendarStartAt: string;
  setCalendarStartAt: Dispatch<SetStateAction<string>>;
  calendarEndAt: string;
  setCalendarEndAt: Dispatch<SetStateAction<string>>;
  calendarError: string;
  calendarNotice: string;
  createCalendarEvent: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  deleteCalendarEvent: (id: string) => Promise<void>;
  exportCalendar: () => Promise<void>;
  syncCalendarToSystem: () => Promise<void>;
  syncCalendarFromSystem: () => Promise<void>;
}

export function CalendarSection({
  className,
  calendarEvents,
  calendarSyncStatus,
  calendarSyncNotice,
  calendarTitle,
  setCalendarTitle,
  calendarStartAt,
  setCalendarStartAt,
  calendarEndAt,
  setCalendarEndAt,
  calendarError,
  calendarNotice,
  createCalendarEvent,
  deleteCalendarEvent,
  exportCalendar,
  syncCalendarToSystem,
  syncCalendarFromSystem,
}: CalendarSectionProps) {
  return (
    <section className={className}>
      <div className="section-heading">
        <div>
          <p className="eyebrow">CALENDAR</p>
          <h2>本地日程</h2>
        </div>
        <div className="section-heading__actions">
          <button type="button" disabled={!calendarEvents.length} onClick={() => void exportCalendar()}>
            导出 iCalendar
          </button>
          <button type="button" disabled={!calendarSyncStatus.available} onClick={() => void syncCalendarToSystem()}>
            同步到系统日历
          </button>
          <button type="button" disabled={!calendarSyncStatus.available} onClick={() => void syncCalendarFromSystem()}>
            从系统日历同步
          </button>
        </div>
      </div>
      <p className="empty-state">
        {calendarSyncStatus.available
          ? `系统同步已就绪 · ${calendarSyncStatus.platform} · 映射 ${calendarSyncStatus.mappingCount} 条`
          : "当前平台未开放系统日历直连，同步按钮将保持为导出/导入式兼容路径。"}
      </p>
      {calendarSyncNotice && <p className="calendar-notice">{calendarSyncNotice}</p>}
      <form className="reminder-form" onSubmit={createCalendarEvent}>
        <input
          value={calendarTitle}
          onChange={(event) => setCalendarTitle(event.currentTarget.value)}
          maxLength={120}
          placeholder="例如：项目评审"
          aria-label="日程标题"
        />
        <input
          type="datetime-local"
          value={calendarStartAt}
          onChange={(event) => setCalendarStartAt(event.currentTarget.value)}
          aria-label="日程开始时间"
        />
        <div>
          <input
            type="datetime-local"
            value={calendarEndAt}
            onChange={(event) => setCalendarEndAt(event.currentTarget.value)}
            aria-label="日程结束时间"
          />
          <button type="submit" disabled={!calendarTitle.trim() || !calendarStartAt || !calendarEndAt}>
            添加
          </button>
        </div>
      </form>
      {calendarError && <p className="reminder-error">{calendarError}</p>}
      {calendarNotice && <p className="calendar-notice">{calendarNotice}</p>}
      {calendarEvents.length ? (
        <ul className="reminder-list">
          {calendarEvents.map((event) => (
            <li key={event.id}>
              <div>
                <strong>{event.title}</strong>
                <span>{formatCalendarRange(event.startAt, event.endAt)}</span>
              </div>
              <button type="button" onClick={() => void deleteCalendarEvent(event.id)}>删除</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-state">暂无日程。</p>
      )}
    </section>
  );
}
