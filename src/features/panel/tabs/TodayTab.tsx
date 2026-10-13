import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Check, Coffee, ListTodo, Pause, Play, Plus, Timer, TriangleAlert } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import type { CalendarSyncStatus, FocusSnapshot, ReminderRepeat, ScheduleItem } from "../../../types/appTypes";
import { EmptyState, ErrorState } from "../../../components/feedback/States";
import { useToast } from "../../../components/feedback/toastStore";
import { toUserMessage } from "../../../lib/errors";
import { defaultFocusSnapshot } from "../../app/appShared";
import { isTauriRuntime, runCommand } from "../../app/appRuntime";
import { previewScheduleItems } from "../previewData";
import { parseQuickAdd } from "../quickAdd";
import "./today.css";
import {
  dayOffset,
  findOverlaps,
  formatClock,
  formatCountdown,
  formatRange,
  greetingFor,
  isOverdue,
  isToday,
  nowSeconds,
  summarizeTodayCount,
  type UnixSeconds,
} from "../time";

const FOCUS_DURATIONS = [15, 25, 45, 60];
const BREAK_DURATIONS = [5, 10, 15];
/** 「接下来」往后看几天。 */
const UPCOMING_DAYS = 7;

const repeatLabels: Record<ReminderRepeat, string> = {
  none: "仅一次",
  daily: "每天",
  weekly: "每周",
  weekdays: "工作日",
};

function kindLabel(item: ScheduleItem): string {
  if (item.kind === "reminder") {
    return item.repeat && item.repeat !== "none" ? `提醒 · ${repeatLabels[item.repeat]}` : "提醒";
  }
  return "日程";
}

/** `<input type="datetime-local">` 的取值与本地时间戳互转。 */
function toDateTimeLocalValue(at: UnixSeconds): string {
  const date = new Date(at * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromDateTimeLocalValue(value: string): UnixSeconds | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.floor(parsed.getTime() / 1000);
}

function defaultQuickAddTime(): string {
  // 默认给下一个整点，减少一次调整。
  const date = new Date();
  date.setMinutes(0, 0, 0);
  date.setHours(date.getHours() + 1);
  return toDateTimeLocalValue(Math.floor(date.getTime() / 1000));
}

/**
 * 「今天」Tab（03 模块）。
 *
 * 心智：今天要做什么、什么时候、现在在专注还是该休息。
 * 提醒与日程在同一条时间线上，用形状区分（提醒是点，日程是区间）。
 */
export function TodayTab() {
  const toast = useToast();
  const [items, setItems] = useState<ScheduleItem[]>([]);
  const [focus, setFocus] = useState<FocusSnapshot>(defaultFocusSnapshot);
  const [loadError, setLoadError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);

  // 快速添加表单
  const [draftTitle, setDraftTitle] = useState("");
  const [draftKind, setDraftKind] = useState<"reminder" | "event">("reminder");
  const [draftAt, setDraftAt] = useState(defaultQuickAddTime);
  const [draftDurationMinutes, setDraftDurationMinutes] = useState(60);
  const [draftRepeat, setDraftRepeat] = useState<ReminderRepeat>("none");
  const [calendarSync, setCalendarSync] = useState<CalendarSyncStatus | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  /**
   * 自然语言识别（03 §4.2）。
   *
   * 只在用户输入能确定时间时给一条「套用」建议，**不直接保存**——
   * 猜错时间比让用户点一下确认更糟。识别不出来就什么都不显示，
   * 用户照常用手动表单。
   */
  const suggestion = useMemo(() => parseQuickAdd(draftTitle), [draftTitle]);

  function applySuggestion() {
    if (!suggestion) return;
    setDraftTitle(suggestion.title);
    setDraftKind(suggestion.kind);
    setDraftAt(toDateTimeLocalValue(suggestion.startAt));
    if (suggestion.kind === "event" && suggestion.endAt) {
      const minutes = Math.round((suggestion.endAt - suggestion.startAt) / 60);
      setDraftDurationMinutes([30, 60, 90, 120].includes(minutes) ? minutes : 60);
    } else {
      setDraftRepeat(suggestion.repeat ?? "none");
    }
  }

  const loadItems = useCallback(async () => {
    try {
      const next = await runCommand<ScheduleItem[]>(
        "list_schedule_items",
        undefined,
        isTauriRuntime ? undefined : previewScheduleItems(),
      );
      setItems(next ?? []);
      setLoadError("");
    } catch (error) {
      setLoadError(toUserMessage(error, "今天的安排加载失败，请重试。"));
    }
  }, []);

  const loadCalendarSyncStatus = useCallback(async () => {
    const status = await runCommand<CalendarSyncStatus>(
      "get_calendar_sync_status",
      undefined,
      // 预览环境没有后端。这里的 fallback 模拟 macOS（目标平台支持直连），
      // 好让浏览器预览与 e2e 能看到「与系统日历同步」这个入口。
      { platform: "macos", available: true, lastSync: null, mappingCount: 0 },
    );
    setCalendarSync(status ?? null);
  }, []);

  /**
   * 03 §7：三个同步按钮收敛成一个入口。
   *
   * 刻意做成**一次性动作**而不是开关：后端没有持久化「是否开启同步」的字段，
   * 做成开关会变成第二个「看起来存在但不生效」的控件。
   */
  async function syncWithSystemCalendar() {
    setIsSyncing(true);
    try {
      const pushed = await runCommand<{ pushed: number }>("sync_calendar_to_system", undefined, { pushed: 0 });
      const pulled = await runCommand<{ imported: number }>("sync_calendar_from_system", undefined, { imported: 0 });
      const parts = [
        pushed?.pushed ? `推出 ${pushed.pushed} 条` : "",
        pulled?.imported ? `导入 ${pulled.imported} 条` : "",
      ].filter(Boolean);
      toast.success(parts.length ? `已与系统日历同步：${parts.join("、")}` : "已与系统日历同步，没有变化");
      await Promise.all([loadItems(), loadCalendarSyncStatus()]);
    } catch (error) {
      toast.error(toUserMessage(error, "与系统日历同步失败，请重试。"));
    } finally {
      setIsSyncing(false);
    }
  }

  async function exportCalendar() {
    const path = await save({
      defaultPath: "piko-calendar.ics",
      filters: [{ name: "iCalendar", extensions: ["ics"] }],
    });
    if (!path) return;
    try {
      await runCommand("export_calendar_events", { path });
      // 用带动作按钮的 toast 取代原生 confirm：R0 已把「原生弹窗」列为要清理的模式。
      toast.show({
        message: "日程已导出",
        tone: "success",
        action: { label: "交给系统日历导入", onClick: () => void runCommand("open_calendar_import", { path }) },
      });
    } catch (error) {
      toast.error(toUserMessage(error, "导出失败，请重试。"));
    }
  }

  const loadFocus = useCallback(async () => {
    const snapshot = await runCommand<FocusSnapshot>("get_focus_state", undefined, defaultFocusSnapshot);
    setFocus(snapshot ?? defaultFocusSnapshot);
  }, []);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      await Promise.all([loadItems(), loadFocus(), loadCalendarSyncStatus()]);
      if (!disposed) setIsLoading(false);
    })();

    const disposers: Array<Promise<() => void>> = [];
    if (isTauriRuntime) {
      disposers.push(listen("schedule-updated", () => void loadItems()));
      disposers.push(listen<FocusSnapshot>("focus-updated", (event) => setFocus(event.payload)));
    }
    return () => {
      disposed = true;
      for (const pending of disposers) {
        void pending.then((dispose) => dispose()).catch(() => undefined);
      }
    };
  }, [loadCalendarSyncStatus, loadFocus, loadItems]);

  // 专注倒计时走本地时钟，不依赖后端每秒推送。
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (focus.status !== "running") return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [focus.status]);
  const remainingSeconds = Math.max(0, focus.remainingSeconds - (focus.status === "running" ? tick : 0));

  const reference = nowSeconds();
  const todayItems = useMemo(
    () => items.filter((item) => isToday(item.startAt, reference)).sort((left, right) => left.startAt - right.startAt),
    [items, reference],
  );
  const upcomingItems = useMemo(
    () =>
      items
        .filter((item) => {
          const offset = dayOffset(item.startAt, reference);
          return offset > 0 && offset <= UPCOMING_DAYS;
        })
        .sort((left, right) => left.startAt - right.startAt),
    [items, reference],
  );
  const overlaps = useMemo(() => findOverlaps(todayItems), [todayItems]);
  const overlappingIds = useMemo(() => {
    const ids = new Set<string>();
    for (const overlap of overlaps) {
      ids.add(overlap.leftId);
      ids.add(overlap.rightId);
    }
    return ids;
  }, [overlaps]);

  async function updateFocus(command: string, args?: Record<string, unknown>) {
    try {
      const snapshot = await runCommand<FocusSnapshot>(command, args, defaultFocusSnapshot);
      setFocus(snapshot ?? defaultFocusSnapshot);
      setTick(0);
    } catch (error) {
      toast.error(toUserMessage(error, "专注操作失败，请重试。"));
    }
  }

  async function completeItem(item: ScheduleItem) {
    try {
      await runCommand("complete_schedule_item", { id: item.id });
      await loadItems();
      toast.success(`已完成：${item.title}`);
    } catch (error) {
      toast.error(toUserMessage(error, "标记完成失败，请重试。"));
    }
  }

  async function deleteItem(item: ScheduleItem) {
    try {
      await runCommand(item.kind === "reminder" ? "delete_reminder" : "delete_calendar_event", { id: item.id });
      await loadItems();
      toast.success("已删除");
    } catch (error) {
      toast.error(toUserMessage(error, "删除失败，请重试。"));
    }
  }

  async function submitQuickAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = draftTitle.trim();
    if (!title) {
      toast.error("先写下要做什么");
      return;
    }
    const startAt = fromDateTimeLocalValue(draftAt);
    if (startAt === null) {
      toast.error("时间没看懂，请重新选择");
      return;
    }
    setIsAdding(true);
    try {
      if (draftKind === "reminder") {
        await runCommand("create_reminder", { input: { title, dueAt: startAt, repeat: draftRepeat } });
      } else {
        await runCommand("create_calendar_event", {
          input: { title, startAt, endAt: startAt + draftDurationMinutes * 60, location: null, notes: null },
        });
      }
      setDraftTitle("");
      setDraftAt(defaultQuickAddTime());
      await loadItems();
      toast.success(draftKind === "reminder" ? "提醒已添加" : "日程已添加");
    } catch (error) {
      toast.error(toUserMessage(error, "添加失败，请重试。"));
    } finally {
      setIsAdding(false);
    }
  }

  const todayCount = todayItems.length;
  const greeting = greetingFor(reference);

  return (
    <div className="tab tab--today">
      <section className="today-greeting" aria-label="问候">
        <h2>{greeting}</h2>
        <p>
          {summarizeTodayCount(todayCount) ?? "今天还没有安排"}
          {focus.status === "running" ? ` · ${focus.kind === "focus" ? "专注中" : "休息中"}` : ""}
        </p>
      </section>

      <section className="today-card today-focus" aria-label="专注与休息">
        {focus.status === "idle" ? (
          <>
            <div className="section-heading">
              <div>
                <p className="eyebrow">FOCUS</p>
                <h2>开始一段专注</h2>
              </div>
              {focus.todayMinutes > 0 ? <span className="today-focus__today">今日 {focus.todayMinutes} 分钟</span> : null}
            </div>
            <div className="today-focus__durations">
              {FOCUS_DURATIONS.map((minutes) => (
                <button key={minutes} type="button" onClick={() => void updateFocus("start_focus", { minutes })}>
                  {minutes} 分钟
                </button>
              ))}
            </div>
            <div className="today-focus__breaks">
              <span>或者休息一下</span>
              {BREAK_DURATIONS.map((minutes) => (
                <button key={minutes} type="button" className="text-action" onClick={() => void updateFocus("start_break", { minutes })}>
                  <Coffee size={14} />
                  {minutes} 分钟
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="section-heading">
              <div>
                <p className="eyebrow">{focus.kind === "focus" ? "FOCUSING" : "BREAK"}</p>
                <h2>{focus.kind === "focus" ? "专注中" : "休息中"}</h2>
              </div>
              {focus.todayMinutes > 0 ? <span className="today-focus__today">今日 {focus.todayMinutes} 分钟</span> : null}
            </div>
            <div className="today-focus__running">
              <Timer size={18} aria-hidden="true" />
              <strong aria-live="polite">{formatCountdown(remainingSeconds)}</strong>
              <div className="today-focus__actions">
                <button
                  type="button"
                  onClick={() => void updateFocus(focus.status === "paused" ? "resume_focus" : "pause_focus")}
                >
                  {focus.status === "paused" ? <Play size={15} /> : <Pause size={15} />}
                  {focus.status === "paused" ? "继续" : "暂停"}
                </button>
                <button type="button" className="text-action" onClick={() => void updateFocus("stop_focus")}>
                  结束
                </button>
              </div>
            </div>
          </>
        )}
      </section>

      <section className="today-card" aria-label="快速添加">
        <form className="today-quick-add" onSubmit={submitQuickAdd}>
          <label className="today-quick-add__title">
            <span className="sr-only">要做什么</span>
            <input
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.currentTarget.value)}
              placeholder="要做什么？例如「明天 10 点开会」"
              aria-label="要做什么"
            />
          </label>
          {suggestion ? (
            <div className="today-quick-add__suggestion" role="status">
              <span>
                识别为：{suggestion.kind === "reminder" ? "提醒" : "日程"} ·{" "}
                {formatClock(suggestion.startAt)}
                {suggestion.repeat && suggestion.repeat !== "none"
                  ? ` · ${repeatLabels[suggestion.repeat]}`
                  : ""}
                {" · "}
                {suggestion.title}
              </span>
              <button type="button" className="text-action" onClick={applySuggestion}>
                套用
              </button>
            </div>
          ) : null}
          <div className="today-quick-add__row">
            <label>
              <span>类型</span>
              <select value={draftKind} onChange={(event) => setDraftKind(event.currentTarget.value as "reminder" | "event")}>
                <option value="reminder">提醒</option>
                <option value="event">日程</option>
              </select>
            </label>
            <label>
              <span>{draftKind === "reminder" ? "提醒时间" : "开始时间"}</span>
              <input
                type="datetime-local"
                value={draftAt}
                onChange={(event) => setDraftAt(event.currentTarget.value)}
                aria-label="时间"
              />
            </label>
            {draftKind === "event" ? (
              <label>
                <span>时长</span>
                <select
                  value={draftDurationMinutes}
                  onChange={(event) => setDraftDurationMinutes(Number(event.currentTarget.value))}
                  aria-label="时长"
                >
                  {[30, 60, 90, 120].map((minutes) => (
                    <option key={minutes} value={minutes}>{minutes} 分钟</option>
                  ))}
                </select>
              </label>
            ) : (
              <label>
                <span>重复</span>
                <select
                  value={draftRepeat}
                  onChange={(event) => setDraftRepeat(event.currentTarget.value as ReminderRepeat)}
                  aria-label="重复"
                >
                  {Object.entries(repeatLabels).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
            )}
            <button type="submit" className="primary-action" disabled={isAdding}>
              <Plus size={15} />
              {isAdding ? "添加中…" : "添加"}
            </button>
          </div>
        </form>
      </section>

      <section className="today-card" aria-label="今天的时间线">
        <div className="section-heading">
          <div>
            <p className="eyebrow">TODAY</p>
            <h2>今天</h2>
          </div>
          {overlaps.length ? (
            <span className="today-conflict" role="status">
              <TriangleAlert size={14} />有 {overlaps.length} 处时间冲突
            </span>
          ) : null}
        </div>

        {loadError ? (
          <ErrorState message={loadError} onRetry={() => void loadItems()} onDismiss={() => setLoadError("")} />
        ) : isLoading ? (
          <p className="today-loading">正在读取今天的安排…</p>
        ) : todayItems.length === 0 ? (
          <EmptyState
            icon={<ListTodo size={20} />}
            title="今天还没有安排"
            description="要不要加一件？上面写一句就行。"
          />
        ) : (
          <ul className="timeline">
            {todayItems.map((item) => {
              const overdue = isOverdue(item, reference);
              const done = item.status === "done";
              return (
                <li
                  key={item.id}
                  className={`timeline__item timeline__item--${item.kind}${overdue ? " is-overdue" : ""}${done ? " is-done" : ""}${overlappingIds.has(item.id) ? " is-conflicting" : ""}`}
                  data-testid="timeline-item"
                  data-kind={item.kind}
                >
                  <span className="timeline__time">
                    {item.kind === "event" ? formatRange(item.startAt, item.endAt) : formatClock(item.startAt)}
                  </span>
                  <span className="timeline__marker" aria-hidden="true" />
                  <span className="timeline__body">
                    <strong>{item.title}</strong>
                    <span className="timeline__meta">
                      {kindLabel(item)}
                      {item.location ? ` · ${item.location}` : ""}
                      {overdue ? " · 已错过" : ""}
                    </span>
                  </span>
                  <span className="timeline__actions">
                    {item.kind === "reminder" && !done ? (
                      <button type="button" aria-label={`完成 ${item.title}`} title="完成" onClick={() => void completeItem(item)}>
                        <Check size={15} />
                      </button>
                    ) : null}
                    <button type="button" aria-label={`删除 ${item.title}`} title="删除" onClick={() => void deleteItem(item)}>
                      ✕
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="today-card today-more" aria-label="更多">
        <div className="section-heading">
          <div>
            <p className="eyebrow">MORE</p>
            <h2>日历</h2>
          </div>
        </div>
        <div className="today-more__row">
          {calendarSync?.available ? (
            <button type="button" disabled={isSyncing} onClick={() => void syncWithSystemCalendar()}>
              {isSyncing ? "同步中…" : "与系统日历同步"}
            </button>
          ) : (
            <span className="today-more__hint">当前系统未开放日历直连，可用导出方式交给系统日历。</span>
          )}
          <button type="button" className="text-action" onClick={() => void exportCalendar()}>
            导出 iCalendar
          </button>
        </div>
        {calendarSync?.lastSync ? (
          <p className="today-more__meta">上次同步：{formatClock(calendarSync.lastSync)}</p>
        ) : null}
      </section>

      {upcomingItems.length ? (
        <details className="today-card today-upcoming">
          <summary>
            接下来 · {upcomingItems.length} 件
          </summary>
          <ul className="timeline timeline--upcoming">
            {upcomingItems.map((item) => (
              <li key={item.id} className={`timeline__item timeline__item--${item.kind}`} data-testid="upcoming-item">
                <span className="timeline__time">
                  {dayOffset(item.startAt, reference) === 1 ? "明天" : "本周"} {formatClock(item.startAt)}
                </span>
                <span className="timeline__marker" aria-hidden="true" />
                <span className="timeline__body">
                  <strong>{item.title}</strong>
                  <span className="timeline__meta">{kindLabel(item)}</span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
