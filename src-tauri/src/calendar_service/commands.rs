use super::{icalendar::*, service::*, CalendarEvent, CalendarEventInput};
use crate::storage;
use std::{fs, path::PathBuf, process::Command};
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub(crate) fn list_calendar_events(app: AppHandle) -> Vec<CalendarEvent> {
    let mut events = read_calendar_events(&app);
    events.sort_by_key(|event| event.start_at);
    events
}

#[tauri::command]
pub(crate) fn create_calendar_event(
    app: AppHandle,
    input: CalendarEventInput,
) -> Result<CalendarEvent, String> {
    create_calendar_event_record(&app, input)
}

#[tauri::command]
pub(crate) fn delete_calendar_event(app: AppHandle, id: String) -> Result<(), String> {
    let _transaction = storage::transaction();
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

#[tauri::command]
pub(crate) fn export_calendar_events(app: AppHandle, path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    validate_icalendar_path(&path)?;
    fs::write(path, render_icalendar(&read_calendar_events(&app))?)
        .map_err(|error| format!("导出日程失败：{error}"))
}

#[tauri::command]
pub(crate) fn open_calendar_import(path: String) -> Result<(), String> {
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
