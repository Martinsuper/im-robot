//! 专注计时（番茄钟与休息）、工作节奏快照、休息提醒与作息安静时段判定。

use chrono::{Local, TimeZone, Timelike};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex, thread, time::Duration};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use thiserror::Error;

use crate::{
    app_awareness, idle_threshold_seconds, persist_settings, read_settings, system_idle_seconds,
    typing_activity, unix_timestamp, AppSettings, ChatRequests, PetVisualEvent,
};

/// 模块内函数的类型化错误。Display 保留原有中文文案，经
/// `From<RhythmError> for String` 兼容命令边界既有的 `Result<_, String>` 签名。
#[derive(Debug, Error)]
pub enum RhythmError {
    #[error("无法获取专注记录路径")]
    FocusRecordsPath,
    #[error("无法获取专注记录目录")]
    FocusRecordsDir,
    #[error("{0}")]
    FocusRecordsIo(String),
    #[error("无法读取专注状态")]
    FocusStateReadLock,
    #[error("无法更新专注状态")]
    FocusStateWriteLock,
    #[error("无法读取前台应用状态")]
    ForegroundStateReadLock,
    #[error("静默时段时间格式应为 HH:MM")]
    InvalidClockFormat,
    #[error("休息提醒间隔应在 15 到 240 分钟之间")]
    InvalidInterval,
    #[error("休息提醒冷却应在 5 到 240 分钟之间")]
    InvalidCooldown,
    /// 透传 typing_activity 等外部模块的 String 错误，文案原样保留。
    #[error("{0}")]
    Message(String),
}

impl From<RhythmError> for String {
    fn from(error: RhythmError) -> Self {
        error.to_string()
    }
}

impl From<String> for RhythmError {
    fn from(message: String) -> Self {
        RhythmError::Message(message)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusRecord {
    pub completed_at: u64,
    pub minutes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusSnapshot {
    status: String,
    kind: String,
    remaining_seconds: u64,
    today_minutes: u64,
}

#[derive(Clone, Debug)]
pub struct ActiveFocus {
    status: String,
    kind: String,
    end_at: u64,
    remaining_seconds: u64,
    minutes: u64,
}

#[derive(Default)]
pub struct FocusTimer(pub Mutex<Option<ActiveFocus>>);

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkRhythmState {
    date: String,
    is_idle: bool,
    idle_seconds: u64,
    active_app_category: String,
    typing_characters_today: u64,
    typing_seconds_today: u64,
    focus_status: String,
    focus_kind: String,
    focus_remaining_seconds: u64,
}

#[derive(Default)]
pub struct WorkRhythmCache(Mutex<Option<WorkRhythmState>>);

#[derive(Clone, Debug, Default, PartialEq)]
struct WorkRhythmReminderState {
    date: String,
    last_sent_bucket: u64,
    last_notified_at: u64,
}

#[derive(Default)]
pub struct WorkRhythmReminderCache(Mutex<WorkRhythmReminderState>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkRhythmPreferencesInput {
    break_reminders_enabled: bool,
    break_reminder_interval_minutes: u64,
    break_reminder_cooldown_minutes: u64,
    break_reminder_quiet_hours_enabled: bool,
    break_reminder_quiet_hours_start: String,
    break_reminder_quiet_hours_end: String,
}

fn focus_records_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("focus-records.json"))
}

fn read_focus_records(app: &AppHandle) -> Vec<FocusRecord> {
    focus_records_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn persist_focus_records(app: &AppHandle, records: &[FocusRecord]) -> Result<(), RhythmError> {
    let path = focus_records_path(app).ok_or(RhythmError::FocusRecordsPath)?;
    let directory = path.parent().ok_or(RhythmError::FocusRecordsDir)?;
    let json = serde_json::to_string(records).map_err(|error| error.to_string())?;

    fs::create_dir_all(directory)
        .map_err(|error| RhythmError::FocusRecordsIo(error.to_string()))?;
    fs::write(path, json).map_err(|error| RhythmError::FocusRecordsIo(error.to_string()))
}

pub fn today_focus_minutes(records: &[FocusRecord], now: u64) -> u64 {
    let today = now / 86_400;
    records
        .iter()
        .filter(|record| record.completed_at / 86_400 == today)
        .map(|record| record.minutes)
        .sum()
}

fn focus_snapshot(app: &AppHandle, focus: &FocusTimer) -> Result<FocusSnapshot, RhythmError> {
    let now = unix_timestamp();
    let active = focus
        .0
        .lock()
        .map_err(|_| RhythmError::FocusStateReadLock)?;
    let (status, kind, remaining_seconds) = active
        .as_ref()
        .map(|active| {
            let remaining = if active.status == "running" {
                active.end_at.saturating_sub(now)
            } else {
                active.remaining_seconds
            };
            (active.status.clone(), active.kind.clone(), remaining)
        })
        .unwrap_or_else(|| ("idle".to_string(), "focus".to_string(), 0));
    Ok(FocusSnapshot {
        status,
        kind,
        remaining_seconds,
        today_minutes: today_focus_minutes(&read_focus_records(app), now),
    })
}

pub fn emit_focus_updated(app: &AppHandle, focus: &FocusTimer) {
    if let Ok(snapshot) = focus_snapshot(app, focus) {
        let _ = app.emit_to("panel", "focus-updated", snapshot);
    }
}

fn work_rhythm_snapshot(
    app: &AppHandle,
    typing: &typing_activity::TypingActivityState,
    focus: &FocusTimer,
) -> Result<WorkRhythmState, RhythmError> {
    let settings = read_settings(app);
    let now = unix_timestamp();
    let focus_snapshot = focus_snapshot(app, focus)?;
    let typing_snapshot = typing.snapshot(now)?;
    let active_app_state = app.state::<app_awareness::ForegroundAppState>();
    let active_app_category = active_app_state
        .current_category
        .lock()
        .map_err(|_| RhythmError::ForegroundStateReadLock)?;
    let chat_active = app
        .state::<ChatRequests>()
        .0
        .lock()
        .map(|requests| !requests.is_empty())
        .unwrap_or(false);
    let focus_is_active = focus_snapshot.status == "running";
    let is_busy = chat_active
        || focus_is_active
        || matches!(
            *active_app_category,
            app_awareness::AppCategory::VideoConference | app_awareness::AppCategory::Game
        );
    let idle_seconds = system_idle_seconds().unwrap_or(0);
    let is_idle = !settings.sensing_paused
        && !is_busy
        && idle_seconds >= idle_threshold_seconds(&settings.quiet_mode);

    Ok(WorkRhythmState {
        date: chrono::Local::now().format("%Y-%m-%d").to_string(),
        is_idle,
        idle_seconds,
        active_app_category: active_app_category.to_string(),
        typing_characters_today: typing_snapshot.typed_characters,
        typing_seconds_today: typing_snapshot.typing_seconds,
        focus_status: focus_snapshot.status,
        focus_kind: focus_snapshot.kind,
        focus_remaining_seconds: focus_snapshot.remaining_seconds,
    })
}

pub fn emit_work_rhythm_updated(app: &AppHandle) {
    let typing = app.state::<typing_activity::TypingActivityState>();
    let focus = app.state::<FocusTimer>();
    if let Ok(snapshot) = work_rhythm_snapshot(app, &typing, &focus) {
        if let Ok(mut last) = app.state::<WorkRhythmCache>().0.lock() {
            if last.as_ref() != Some(&snapshot) {
                *last = Some(snapshot.clone());
                let _ = app.emit_to("panel", "work-rhythm-updated", snapshot.clone());
                if let Ok(typing_snapshot) = typing.snapshot(unix_timestamp()) {
                    let _ = app.emit_to("panel", "typing-stats-updated", typing_snapshot);
                }
            }
        }
    }
}

fn maybe_emit_break_reminder(app: &AppHandle) {
    let typing = app.state::<typing_activity::TypingActivityState>();
    let focus = app.state::<FocusTimer>();
    let settings = read_settings(app);
    let Ok(snapshot) = work_rhythm_snapshot(app, &typing, &focus) else {
        return;
    };

    if settings.sensing_paused
        || !settings.break_reminders_enabled
        || settings.quiet_mode == "minimal"
    {
        return;
    }
    if snapshot.is_idle || snapshot.focus_status == "running" || snapshot.focus_kind == "break" {
        return;
    }
    if matches!(
        snapshot.active_app_category.as_str(),
        "video_conference" | "game"
    ) {
        return;
    }

    if is_within_quiet_hours(
        &settings.break_reminder_quiet_hours_start,
        &settings.break_reminder_quiet_hours_end,
        settings.break_reminder_quiet_hours_enabled,
        unix_timestamp(),
    ) {
        return;
    }

    let interval_seconds = settings.break_reminder_interval_minutes.saturating_mul(60);
    let cooldown_seconds = settings.break_reminder_cooldown_minutes.saturating_mul(60);
    if interval_seconds == 0 || cooldown_seconds == 0 {
        return;
    }

    let bucket = snapshot.typing_seconds_today / interval_seconds;
    if bucket == 0 {
        return;
    }

    let now = unix_timestamp();
    let reminder_state = app.state::<WorkRhythmReminderCache>();
    let Ok(mut state) = reminder_state.0.lock() else {
        return;
    };
    if state.date != snapshot.date {
        *state = WorkRhythmReminderState {
            date: snapshot.date.clone(),
            last_sent_bucket: 0,
            last_notified_at: 0,
        };
    }
    if bucket <= state.last_sent_bucket {
        return;
    }
    if now.saturating_sub(state.last_notified_at) < cooldown_seconds {
        return;
    }

    let reminder_minutes = bucket.saturating_mul(settings.break_reminder_interval_minutes);
    let message = format!("你已经连续工作约 {reminder_minutes} 分钟了，要不要休息 5 分钟？");
    let _ = app
        .notification()
        .builder()
        .title("Piko 休息提醒")
        .body(&message)
        .show();
    let _ = app.emit_to(
        "pet",
        "pet-visual-event",
        PetVisualEvent::BreakReminder { message },
    );
    state.last_sent_bucket = bucket;
    state.last_notified_at = now;
}

fn parse_clock_minutes(value: &str) -> Option<u64> {
    let (hour, minute) = value.trim().split_once(':')?;
    let hour = hour.parse::<u64>().ok()?;
    let minute = minute.parse::<u64>().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    Some(hour * 60 + minute)
}

pub fn is_within_quiet_hours(start: &str, end: &str, enabled: bool, now: u64) -> bool {
    if !enabled {
        return false;
    }
    let Some(start_minutes) = parse_clock_minutes(start) else {
        return false;
    };
    let Some(end_minutes) = parse_clock_minutes(end) else {
        return false;
    };
    let Some(now_local) = Local.timestamp_opt(now as i64, 0).single() else {
        return false;
    };
    let current_minutes = (now_local.hour() as u64) * 60 + (now_local.minute() as u64);
    if start_minutes == end_minutes {
        return true;
    }
    if start_minutes < end_minutes {
        current_minutes >= start_minutes && current_minutes < end_minutes
    } else {
        current_minutes >= start_minutes || current_minutes < end_minutes
    }
}

fn normalize_clock_label(value: &str) -> Result<String, RhythmError> {
    let Some(minutes) = parse_clock_minutes(value) else {
        return Err(RhythmError::InvalidClockFormat);
    };
    let hour = minutes / 60;
    let minute = minutes % 60;
    Ok(format!("{hour:02}:{minute:02}"))
}

fn validate_work_rhythm_preferences(input: &WorkRhythmPreferencesInput) -> Result<(), RhythmError> {
    if !(15..=240).contains(&input.break_reminder_interval_minutes) {
        return Err(RhythmError::InvalidInterval);
    }
    if !(5..=240).contains(&input.break_reminder_cooldown_minutes) {
        return Err(RhythmError::InvalidCooldown);
    }
    let _ = normalize_clock_label(&input.break_reminder_quiet_hours_start)?;
    let _ = normalize_clock_label(&input.break_reminder_quiet_hours_end)?;
    Ok(())
}

#[tauri::command]
pub fn get_focus_state(
    app: AppHandle,
    focus: State<'_, FocusTimer>,
) -> Result<FocusSnapshot, String> {
    Ok(focus_snapshot(&app, &focus)?)
}

#[tauri::command]
pub fn get_work_rhythm_state(
    app: AppHandle,
    typing: State<'_, typing_activity::TypingActivityState>,
    focus: State<'_, FocusTimer>,
) -> Result<WorkRhythmState, String> {
    Ok(work_rhythm_snapshot(&app, &typing, &focus)?)
}

#[tauri::command]
pub fn start_focus(
    app: AppHandle,
    focus: State<'_, FocusTimer>,
    minutes: u64,
) -> Result<FocusSnapshot, String> {
    if !matches!(minutes, 15 | 25 | 45 | 60) {
        return Err("专注时长仅支持 15、25、45 或 60 分钟".to_string());
    }
    start_timer(&focus, "focus", minutes)?;
    let _ = app.emit_to("pet", "pet-visual-event", PetVisualEvent::FocusStarted);
    emit_focus_updated(&app, &focus);
    Ok(focus_snapshot(&app, &focus)?)
}

fn start_timer(focus: &FocusTimer, kind: &str, minutes: u64) -> Result<(), RhythmError> {
    *focus
        .0
        .lock()
        .map_err(|_| RhythmError::FocusStateWriteLock)? = Some(ActiveFocus {
        status: "running".to_string(),
        kind: kind.to_string(),
        end_at: unix_timestamp() + minutes * 60,
        remaining_seconds: minutes * 60,
        minutes,
    });
    Ok(())
}

#[tauri::command]
pub fn start_break(
    app: AppHandle,
    focus: State<'_, FocusTimer>,
    minutes: u64,
) -> Result<FocusSnapshot, String> {
    if !matches!(minutes, 5 | 10 | 15) {
        return Err("休息时长仅支持 5、10 或 15 分钟".to_string());
    }
    start_timer(&focus, "break", minutes)?;
    emit_focus_updated(&app, &focus);
    Ok(focus_snapshot(&app, &focus)?)
}

#[tauri::command]
pub fn pause_focus(app: AppHandle, focus: State<'_, FocusTimer>) -> Result<FocusSnapshot, String> {
    let now = unix_timestamp();
    {
        let mut active = focus.0.lock().map_err(|_| "无法更新专注状态".to_string())?;
        let active = active
            .as_mut()
            .ok_or_else(|| "当前没有专注计时".to_string())?;
        if active.status == "running" {
            active.remaining_seconds = active.end_at.saturating_sub(now);
            active.status = "paused".to_string();
        }
    }
    emit_focus_updated(&app, &focus);
    Ok(focus_snapshot(&app, &focus)?)
}

#[tauri::command]
pub fn resume_focus(app: AppHandle, focus: State<'_, FocusTimer>) -> Result<FocusSnapshot, String> {
    {
        let mut active = focus.0.lock().map_err(|_| "无法更新专注状态".to_string())?;
        let active = active
            .as_mut()
            .ok_or_else(|| "当前没有专注计时".to_string())?;
        if active.status == "paused" {
            active.end_at = unix_timestamp() + active.remaining_seconds;
            active.status = "running".to_string();
        }
    }
    emit_focus_updated(&app, &focus);
    Ok(focus_snapshot(&app, &focus)?)
}

#[tauri::command]
pub fn stop_focus(app: AppHandle, focus: State<'_, FocusTimer>) -> Result<FocusSnapshot, String> {
    *focus.0.lock().map_err(|_| "无法更新专注状态".to_string())? = None;
    emit_focus_updated(&app, &focus);
    Ok(focus_snapshot(&app, &focus)?)
}

#[tauri::command]
pub fn update_work_rhythm_preferences(
    app: AppHandle,
    input: WorkRhythmPreferencesInput,
) -> Result<AppSettings, String> {
    validate_work_rhythm_preferences(&input)?;

    let mut settings = read_settings(&app);
    settings.break_reminders_enabled = input.break_reminders_enabled;
    settings.break_reminder_interval_minutes = input.break_reminder_interval_minutes;
    settings.break_reminder_cooldown_minutes = input.break_reminder_cooldown_minutes;
    settings.break_reminder_quiet_hours_enabled = input.break_reminder_quiet_hours_enabled;
    settings.break_reminder_quiet_hours_start =
        normalize_clock_label(&input.break_reminder_quiet_hours_start)?;
    settings.break_reminder_quiet_hours_end =
        normalize_clock_label(&input.break_reminder_quiet_hours_end)?;
    persist_settings(&app, &settings);
    let _ = app.emit_to("panel", "settings-updated", &settings);
    let _ = app.emit_to("pet", "settings-updated", &settings);
    let _ = app.emit_to("bubble", "settings-updated", &settings);
    emit_work_rhythm_updated(&app);
    Ok(settings)
}

fn process_focus_timer(app: &AppHandle, focus: &FocusTimer) -> Result<bool, RhythmError> {
    let now = unix_timestamp();
    let completed = {
        let mut active = focus
            .0
            .lock()
            .map_err(|_| RhythmError::FocusStateReadLock)?;
        if active
            .as_ref()
            .is_some_and(|active| active.status == "running" && active.end_at <= now)
        {
            active.take()
        } else {
            None
        }
    };
    let Some(completed) = completed else {
        return Ok(false);
    };

    if completed.kind == "focus" {
        let mut records = read_focus_records(app);
        records.push(FocusRecord {
            completed_at: now,
            minutes: completed.minutes,
        });
        persist_focus_records(app, &records)?;
    }
    let message = if completed.kind == "break" {
        "休息结束，可以开始下一轮专注了。"
    } else {
        "专注结束，休息一下吧。"
    };
    let _ = app
        .notification()
        .builder()
        .title("Piko 专注")
        .body(message)
        .show();
    let _ = app.emit_to("pet", "pet-visual-event", PetVisualEvent::FocusCompleted);
    emit_focus_updated(app, focus);
    Ok(true)
}

pub fn watch_focus_timer(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || loop {
        let focus = app.state::<FocusTimer>();
        let _ = process_focus_timer(&app, &focus);
        thread::sleep(Duration::from_secs(1));
    });
}

pub fn watch_ambient_nudges(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || loop {
        let settings = read_settings(&app);
        let delay = match settings.quiet_mode.as_str() {
            "active" => 45,
            "minimal" => 300,
            _ => 120,
        };
        thread::sleep(Duration::from_secs(delay));
        if !settings.sensing_paused && settings.quiet_mode != "minimal" {
            let _ = app.emit_to("pet", "pet-visual-event", PetVisualEvent::AmbientNudge);
        }
    });
}

pub fn watch_work_rhythm(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || loop {
        emit_work_rhythm_updated(&app);
        maybe_emit_break_reminder(&app);
        thread::sleep(Duration::from_secs(2));
    });
}
