//! 日程：日程事件的持久化、增删与批量删除命令、插件工具入参解析、冲突检测、
//! iCalendar 导出、系统日历同步命令，以及开始前通知的后台线程。

use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use thiserror::Error;

use crate::{tool_timestamp, tool_timestamp_str, unix_timestamp, PetVisualEvent, ToolCall};

/// 模块内函数的类型化错误。Display 保留原有中文文案，经
/// `From<CalendarError> for String` 兼容命令边界既有的 `Result<_, String>` 签名。
#[derive(Debug, Error)]
pub enum CalendarError {
    #[error("无法获取日程记录路径")]
    StoragePath,
    #[error("无法获取日程记录目录")]
    StorageDir,
    #[error("{0}")]
    StorageIo(String),
    #[error("日程标题不能为空")]
    EmptyTitle,
    #[error("日程标题不能超过 120 个字符")]
    TitleTooLong,
    #[error("日程开始时间必须晚于当前时间")]
    StartInPast,
    #[error("日程结束时间必须晚于开始时间")]
    EndBeforeStart,
    #[error("日程 ID 不能为空")]
    EmptyId,
    #[error("批量日程必须包含 events 数组")]
    BatchMissingEvents,
    #[error("批量日程数量必须在 1 到 20 之间")]
    InvalidBatchSize,
    #[error("批量删除日程必须包含 events 数组")]
    DeleteBatchMissingEvents,
    #[error("批量删除日程数量必须在 1 到 100 之间")]
    InvalidDeleteBatchSize,
    #[error("批量删除日程中包含重复 ID：{0}")]
    DuplicateDeleteId(String),
    #[error("部分待删除日程已不存在，请重新查询日程后再试")]
    DeleteTargetMissing,
    #[error("未找到该日程")]
    NotFound,
    #[error("日程开始时间无效")]
    InvalidStartTime,
    #[error("日程结束时间无效")]
    InvalidEndTime,
    #[error("日程导出文件必须使用 .ics 扩展名")]
    InvalidIcsExtension,
    #[error("无法读取日程提醒状态")]
    NotificationStateReadLock,
    /// 透传 tool_timestamp、calendar_sync 等外部模块的 String 错误，文案原样保留。
    #[error("{0}")]
    Message(String),
}

impl From<CalendarError> for String {
    fn from(error: CalendarError) -> Self {
        error.to_string()
    }
}

impl From<String> for CalendarError {
    fn from(message: String) -> Self {
        CalendarError::Message(message)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub title: String,
    pub start_at: u64,
    pub end_at: u64,
    pub location: Option<String>,
    pub notes: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEventInput {
    pub title: String,
    pub start_at: u64,
    pub end_at: u64,
    pub location: Option<String>,
    pub notes: Option<String>,
}

#[derive(Clone, Debug)]
pub struct CalendarEventBatchInput {
    pub events: Vec<CalendarEventInput>,
}

#[derive(Default)]
pub struct CalendarNotificationCache(Mutex<HashSet<String>>);

pub fn calendar_events_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("calendar-events.json"))
}

pub fn read_calendar_events(app: &AppHandle) -> Vec<CalendarEvent> {
    calendar_events_path(app)
        .map(|path| read_calendar_events_from_path(&path))
        .unwrap_or_default()
}

pub fn read_calendar_events_from_path(path: &Path) -> Vec<CalendarEvent> {
    fs::read_to_string(path)
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

pub fn persist_calendar_events(
    app: &AppHandle,
    events: &[CalendarEvent],
) -> Result<(), CalendarError> {
    let path = calendar_events_path(app).ok_or(CalendarError::StoragePath)?;
    persist_calendar_events_to_path(&path, events)
}

pub fn persist_calendar_events_to_path(
    path: &Path,
    events: &[CalendarEvent],
) -> Result<(), CalendarError> {
    let directory = path.parent().ok_or(CalendarError::StorageDir)?;
    let json = serde_json::to_string(events).map_err(|error| error.to_string())?;

    fs::create_dir_all(directory).map_err(|error| CalendarError::StorageIo(error.to_string()))?;
    fs::write(path, json).map_err(|error| CalendarError::StorageIo(error.to_string()))
}

fn calendar_event_id() -> String {
    format!(
        "calendar-event-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

pub fn find_calendar_conflicts(
    events: &[CalendarEvent],
    start_at: u64,
    end_at: u64,
) -> Vec<CalendarEvent> {
    events
        .iter()
        .filter(|event| event.start_at < end_at && start_at < event.end_at)
        .cloned()
        .collect()
}

pub fn coalesce_calendar_delete_calls(calls: Vec<(String, ToolCall)>) -> Vec<(String, ToolCall)> {
    let delete_count = calls
        .iter()
        .filter(|(_, call)| call.plugin_id == "piko.calendar" && call.tool_name == "delete_event")
        .count();
    if delete_count <= 1 {
        return calls;
    }

    let events = calls
        .iter()
        .filter(|(_, call)| call.plugin_id == "piko.calendar" && call.tool_name == "delete_event")
        .map(|(_, call)| call.arguments.clone())
        .collect::<Vec<_>>();
    let mut batch = Some(events);
    calls
        .into_iter()
        .filter_map(|(id, mut call)| {
            if call.plugin_id != "piko.calendar" || call.tool_name != "delete_event" {
                return Some((id, call));
            }
            let events = batch.take()?;
            call.tool_name = "delete_event_batch".to_string();
            call.arguments = json!({ "events": events });
            Some((id, call))
        })
        .collect()
}

pub fn calendar_event_input_from_value(value: &Value) -> Result<CalendarEventInput, CalendarError> {
    let title = value["title"]
        .as_str()
        .ok_or(CalendarError::EmptyTitle)?
        .to_string();
    let start_at = tool_timestamp(&value["startAt"])?;
    let end_at = tool_timestamp(&value["endAt"])?;
    let location = value["location"].as_str().map(str::to_string);
    let notes = value["notes"].as_str().map(str::to_string);
    Ok(CalendarEventInput {
        title,
        start_at,
        end_at,
        location,
        notes,
    })
}

pub fn calendar_event_batch_input_from_value(
    value: &Value,
) -> Result<CalendarEventBatchInput, CalendarError> {
    let events = value["events"]
        .as_array()
        .ok_or(CalendarError::BatchMissingEvents)?;
    if events.is_empty() || events.len() > 20 {
        return Err(CalendarError::InvalidBatchSize);
    }
    Ok(CalendarEventBatchInput {
        events: events
            .iter()
            .map(calendar_event_input_from_value)
            .collect::<Result<Vec<_>, _>>()?,
    })
}

#[derive(Clone, Debug)]
pub struct CalendarDeleteInput {
    pub id: String,
    pub title: Option<String>,
    pub start_at: Option<u64>,
    pub end_at: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct CalendarDeleteBatchInput {
    pub events: Vec<CalendarDeleteInput>,
}

pub fn calendar_delete_input_from_value(
    value: &Value,
) -> Result<CalendarDeleteInput, CalendarError> {
    let id = value["id"]
        .as_str()
        .ok_or(CalendarError::EmptyId)?
        .to_string();
    Ok(CalendarDeleteInput {
        id,
        title: value["title"].as_str().map(str::to_string),
        start_at: value["startAt"].as_str().and_then(tool_timestamp_str),
        end_at: value["endAt"].as_str().and_then(tool_timestamp_str),
    })
}

pub fn calendar_delete_batch_input_from_value(
    value: &Value,
) -> Result<CalendarDeleteBatchInput, CalendarError> {
    let events = value["events"]
        .as_array()
        .ok_or(CalendarError::DeleteBatchMissingEvents)?;
    if events.is_empty() || events.len() > 100 {
        return Err(CalendarError::InvalidDeleteBatchSize);
    }
    Ok(CalendarDeleteBatchInput {
        events: events
            .iter()
            .map(calendar_delete_input_from_value)
            .collect::<Result<Vec<_>, _>>()?,
    })
}

#[tauri::command]
pub fn list_calendar_events(app: AppHandle) -> Vec<CalendarEvent> {
    let mut events = read_calendar_events(&app);
    events.sort_by_key(|event| event.start_at);
    events
}

pub fn create_calendar_event_record(
    app: &AppHandle,
    input: CalendarEventInput,
) -> Result<CalendarEvent, CalendarError> {
    let path = calendar_events_path(app).ok_or(CalendarError::StoragePath)?;
    let event = create_calendar_event_record_at_path(&path, input)?;
    let _ = app.emit("calendar-events-updated", ());
    Ok(event)
}

pub fn create_calendar_event_record_at_path(
    path: &Path,
    input: CalendarEventInput,
) -> Result<CalendarEvent, CalendarError> {
    let mut events = read_calendar_events_from_path(path);
    let event = calendar_event_from_input(input)?;
    events.push(event.clone());
    persist_calendar_events_to_path(path, &events)?;
    Ok(event)
}

pub fn delete_calendar_event_record(
    app: &AppHandle,
    input: CalendarDeleteInput,
) -> Result<CalendarEvent, CalendarError> {
    let mut events = read_calendar_events(app);
    let index = events
        .iter()
        .position(|event| event.id == input.id)
        .ok_or(CalendarError::NotFound)?;
    let deleted = events.remove(index);
    persist_calendar_events(app, &events)?;
    crate::sync::calendar_sync::mark_local_events_deleted(app, std::slice::from_ref(&deleted.id))?;
    let _ = app.emit("calendar-events-updated", ());
    Ok(deleted)
}

pub fn delete_calendar_event_batch_record(
    app: &AppHandle,
    input: CalendarDeleteBatchInput,
) -> Result<Vec<CalendarEvent>, CalendarError> {
    let path = calendar_events_path(app).ok_or(CalendarError::StoragePath)?;
    let deleted = delete_calendar_event_batch_record_at_path(&path, input)?;
    let deleted_ids = deleted
        .iter()
        .map(|event| event.id.clone())
        .collect::<Vec<_>>();
    crate::sync::calendar_sync::mark_local_events_deleted(app, &deleted_ids)?;
    let _ = app.emit("calendar-events-updated", ());
    Ok(deleted)
}

pub fn delete_calendar_event_batch_record_at_path(
    path: &Path,
    input: CalendarDeleteBatchInput,
) -> Result<Vec<CalendarEvent>, CalendarError> {
    let mut ids = HashSet::new();
    for event in &input.events {
        if !ids.insert(event.id.as_str()) {
            return Err(CalendarError::DuplicateDeleteId(event.id.clone()));
        }
    }

    let mut events = read_calendar_events_from_path(path);
    let deleted = events
        .iter()
        .filter(|event| ids.contains(event.id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if deleted.len() != ids.len() {
        return Err(CalendarError::DeleteTargetMissing);
    }
    events.retain(|event| !ids.contains(event.id.as_str()));
    persist_calendar_events_to_path(path, &events)?;
    Ok(deleted)
}

pub fn calendar_conflict_note(
    existing_events: &[CalendarEvent],
    start_at: u64,
    end_at: u64,
) -> Option<String> {
    let conflicts = find_calendar_conflicts(existing_events, start_at, end_at);
    if conflicts.is_empty() {
        None
    } else {
        Some(format!(
            "提示：该时间段与已有 {} 条日程重叠，但已继续创建。",
            conflicts.len()
        ))
    }
}

pub fn calendar_event_from_input(
    input: CalendarEventInput,
) -> Result<CalendarEvent, CalendarError> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err(CalendarError::EmptyTitle);
    }
    if title.chars().count() > 120 {
        return Err(CalendarError::TitleTooLong);
    }
    if input.start_at <= unix_timestamp() {
        return Err(CalendarError::StartInPast);
    }
    if input.end_at <= input.start_at {
        return Err(CalendarError::EndBeforeStart);
    }
    Ok(CalendarEvent {
        id: calendar_event_id(),
        title: title.to_string(),
        start_at: input.start_at,
        end_at: input.end_at,
        location: input.location.filter(|value| !value.trim().is_empty()),
        notes: input.notes.filter(|value| !value.trim().is_empty()),
    })
}

pub fn create_calendar_event_batch_record(
    app: &AppHandle,
    batch: CalendarEventBatchInput,
) -> Result<Vec<CalendarEvent>, CalendarError> {
    let mut events = read_calendar_events(app);
    let mut created = Vec::with_capacity(batch.events.len());
    for input in batch.events {
        let event = calendar_event_from_input(input)?;
        events.push(event.clone());
        created.push(event);
    }
    persist_calendar_events(app, &events)?;
    let _ = app.emit("calendar-events-updated", ());
    Ok(created)
}

#[tauri::command]
pub fn create_calendar_event(
    app: AppHandle,
    input: CalendarEventInput,
) -> Result<CalendarEvent, String> {
    Ok(create_calendar_event_record(&app, input)?)
}

#[tauri::command]
pub fn delete_calendar_event(app: AppHandle, id: String) -> Result<(), String> {
    let mut events = read_calendar_events(&app);
    let previous_len = events.len();
    events.retain(|event| event.id != id);
    if events.len() == previous_len {
        return Err("未找到该日程".to_string());
    }
    persist_calendar_events(&app, &events)?;
    crate::sync::calendar_sync::mark_local_events_deleted(&app, &[id])?;
    let _ = app.emit("calendar-events-updated", ());
    Ok(())
}

pub fn escape_icalendar_text(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace('\n', "\\n")
}

pub fn render_icalendar(events: &[CalendarEvent]) -> Result<String, CalendarError> {
    let mut lines = vec![
        "BEGIN:VCALENDAR".to_string(),
        "VERSION:2.0".to_string(),
        "PRODID:-//Piko//Local Calendar//EN".to_string(),
        "CALSCALE:GREGORIAN".to_string(),
    ];
    for event in events {
        let start = Local
            .timestamp_opt(event.start_at as i64, 0)
            .single()
            .ok_or(CalendarError::InvalidStartTime)?
            .with_timezone(&chrono::Utc)
            .format("%Y%m%dT%H%M%SZ")
            .to_string();
        let end = Local
            .timestamp_opt(event.end_at as i64, 0)
            .single()
            .ok_or(CalendarError::InvalidEndTime)?
            .with_timezone(&chrono::Utc)
            .format("%Y%m%dT%H%M%SZ")
            .to_string();
        lines.extend([
            "BEGIN:VEVENT".to_string(),
            format!("UID:{}@piko.local", escape_icalendar_text(&event.id)),
            format!("DTSTAMP:{}", chrono::Utc::now().format("%Y%m%dT%H%M%SZ")),
            format!("DTSTART:{start}"),
            format!("DTEND:{end}"),
            format!("SUMMARY:{}", escape_icalendar_text(&event.title)),
        ]);
        if let Some(location) = &event.location {
            lines.push(format!("LOCATION:{}", escape_icalendar_text(location)));
        }
        if let Some(notes) = &event.notes {
            lines.push(format!("DESCRIPTION:{}", escape_icalendar_text(notes)));
        }
        lines.push("END:VEVENT".to_string());
    }
    lines.push("END:VCALENDAR".to_string());
    Ok(format!("{}\r\n", lines.join("\r\n")))
}

pub fn validate_icalendar_path(path: &Path) -> Result<(), CalendarError> {
    if path.extension().and_then(|extension| extension.to_str()) == Some("ics") {
        Ok(())
    } else {
        Err(CalendarError::InvalidIcsExtension)
    }
}

#[tauri::command]
pub fn export_calendar_events(app: AppHandle, path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    validate_icalendar_path(&path)?;
    fs::write(path, render_icalendar(&read_calendar_events(&app))?)
        .map_err(|error| format!("导出日程失败：{error}"))
}

#[tauri::command]
pub fn open_calendar_import(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    validate_icalendar_path(&path)?;
    if !path.exists() {
        return Err("日程导出文件不存在".to_string());
    }
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", ""]);
        command
    };
    #[cfg(target_os = "linux")]
    let mut command = Command::new("xdg-open");
    command
        .arg(path)
        .spawn()
        .map_err(|error| format!("无法打开系统日历导入：{error}"))?;
    Ok(())
}

pub fn collect_due_calendar_events(
    events: &[CalendarEvent],
    now: u64,
    already_notified: &mut HashSet<String>,
) -> Vec<CalendarEvent> {
    const CALENDAR_EVENT_NOTICE_WINDOW_SECONDS: u64 = 60;

    events
        .iter()
        .filter(|event| {
            event.start_at <= now
                && now.saturating_sub(event.start_at) <= CALENDAR_EVENT_NOTICE_WINDOW_SECONDS
                && already_notified.insert(event.id.clone())
        })
        .cloned()
        .collect()
}

pub fn format_calendar_notice(event: &CalendarEvent) -> String {
    match event
        .location
        .as_deref()
        .map(str::trim)
        .filter(|location| !location.is_empty())
    {
        Some(location) => format!("日程：{} · {}", event.title, location),
        None => format!("日程：{}", event.title),
    }
}

pub fn process_due_calendar_events(app: &AppHandle) -> Result<Vec<CalendarEvent>, CalendarError> {
    let now = unix_timestamp();
    let events = read_calendar_events(app);
    let calendar_notifications = app.state::<CalendarNotificationCache>();
    let mut already_notified = calendar_notifications
        .0
        .lock()
        .map_err(|_| CalendarError::NotificationStateReadLock)?;
    let due = collect_due_calendar_events(&events, now, &mut already_notified);
    drop(already_notified);

    for event in &due {
        let message = format_calendar_notice(event);
        let _ = app
            .notification()
            .builder()
            .title("Piko 日程")
            .body(&message)
            .show();
        let _ = app.emit_to(
            "pet",
            "pet-visual-event",
            PetVisualEvent::CalendarEventDue { message },
        );
    }

    Ok(due)
}

pub fn watch_calendar_events(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || loop {
        let _ = process_due_calendar_events(&app);
        thread::sleep(Duration::from_secs(10));
    });
}

// ============================================================================
// CALENDAR SYNC COMMANDS
// ============================================================================

#[tauri::command]
pub fn get_calendar_sync_status(app: AppHandle) -> Result<serde_json::Value, String> {
    let mappings = crate::sync::calendar_sync::read_sync_mappings(&app);
    let available = crate::sync::calendar_sync::is_sync_available();
    let platform = crate::sync::calendar_sync::current_platform();

    Ok(json!({
        "platform": platform,
        "available": available,
        "mappingCount": mappings.len(),
        "lastSync": mappings.iter().map(|m| m.last_synced_at).max(),
    }))
}

#[tauri::command]
pub fn sync_calendar_to_system(app: AppHandle) -> Result<serde_json::Value, String> {
    let events = read_calendar_events(&app);
    let result = crate::sync::calendar_sync::push_to_system_calendar(&app, &events)?;
    let _ = app.emit_to("panel", "calendar-sync-updated", ());
    Ok(json!({
        "pushed": result.pushed,
        "mappingCount": result.mappings.len(),
    }))
}

#[tauri::command]
pub fn sync_calendar_from_system(app: AppHandle) -> Result<serde_json::Value, String> {
    let since = crate::sync::calendar_sync::read_sync_mappings(&app)
        .iter()
        .map(|mapping| mapping.last_synced_at)
        .max()
        .unwrap_or(0);
    let result = crate::sync::calendar_sync::pull_from_system_calendar(&app, since)?;
    let _ = app.emit("calendar-events-updated", ());
    let _ = app.emit_to("panel", "calendar-sync-updated", ());
    Ok(json!({
        "imported": result.imported,
        "events": result.events,
    }))
}
