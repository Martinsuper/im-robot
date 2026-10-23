import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import type { ScheduleItem } from "../../types/appTypes";

import { dateKey, itemsForDay } from "./scheduleCalendarData";

export function ScheduleCalendar({ items, selected, onSelect, today }: {
  items: ScheduleItem[]; selected: Date; onSelect: (day: Date) => void; today: Date;
}) {
  const [month, setMonth] = useState(() => new Date(selected.getFullYear(), selected.getMonth(), 1));
  const days = useMemo(() => {
    const offset = (month.getDay() + 6) % 7;
    const length = Math.ceil((offset + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) / 7) * 7;
    return Array.from({ length }, (_, index) => new Date(month.getFullYear(), month.getMonth(), index - offset + 1));
  }, [month]);
  function goToday() {
    setMonth(new Date(today.getFullYear(), today.getMonth(), 1));
    onSelect(today);
  }
  return <section className="schedule-calendar" aria-label="日历">
    <div className="schedule-calendar__date"><span>{today.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" })}</span><button type="button" onClick={goToday}>回到今天</button></div>
    <div className="schedule-calendar__heading"><h2>{month.getFullYear()} 年 {month.getMonth() + 1} 月</h2><div><button type="button" aria-label="上个月" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft size={17} /></button><button type="button" aria-label="下个月" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight size={17} /></button></div></div>
    <div className="schedule-calendar__week" aria-hidden="true">{["一", "二", "三", "四", "五", "六", "日"].map(day => <span key={day}>{day}</span>)}</div>
    <div className="schedule-calendar__days" role="group" aria-label="选择日期">
      {days.map(day => {
        const key = dateKey(day);
        const count = itemsForDay(items, day).length;
        return <button type="button" key={key} className={`${day.getMonth() !== month.getMonth() ? "is-outside " : ""}${dateKey(selected) === key ? "is-selected" : ""}`} aria-label={`${day.getFullYear()}年${day.getMonth() + 1}月${day.getDate()}日，${count}件事`} aria-pressed={dateKey(selected) === key} aria-current={dateKey(today) === key ? "date" : undefined} onClick={() => { onSelect(day); if (day.getMonth() !== month.getMonth()) setMonth(new Date(day.getFullYear(), day.getMonth(), 1)); }}>
          <span>{day.getDate()}</span><span className="schedule-calendar__dots" aria-hidden="true">{Array.from({ length: Math.min(count, 3) }, (_, index) => <i key={index} />)}</span>
        </button>;
      })}
    </div>
    <p className="schedule-calendar__legend"><i />圆点越多，安排越多</p>
  </section>;
}
