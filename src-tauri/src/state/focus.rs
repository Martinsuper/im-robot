use crate::types::{ActiveFocus, FocusRecord, FocusSnapshot};
use chrono::{Local, TimeZone};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct FocusTimer(pub Mutex<Option<ActiveFocus>>);

pub fn today_focus_minutes(records: &[FocusRecord], now: u64) -> u64 {
    let today = now / 86_400;
    records
        .iter()
        .filter(|record| record.completed_at / 86_400 == today)
        .map(|record| record.minutes)
        .sum()
}

pub fn focus_snapshot(app: &AppHandle, focus: &FocusTimer) -> Result<FocusSnapshot, String> {
    let focus = focus
        .0
        .lock()
        .map_err(|_| "无法获取专注计时器状态".to_string())?;
    let active = focus.as_ref().ok_or_else(|| "当前没有专注计时器".to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let remaining_seconds = if now >= active.end_at {
        0
    } else {
        (active.end_at - now) / 60
    };
    let today_minutes = today_focus_minutes(&read_focus_records(app), now);
    Ok(FocusSnapshot {
        status: active.status.clone(),
        kind: active.kind.clone(),
        remaining_seconds,
        today_minutes,
    })
}

fn read_focus_records(app: &AppHandle) -> Vec<FocusRecord> {
    focus_records_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn focus_records_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("focus-records.json"))
}

pub fn emit_focus_updated(app: &AppHandle, focus: &FocusTimer) {
    if let Ok(snapshot) = focus_snapshot(app, focus) {
        let _ = app.emit_to("panel", "focus-updated", snapshot);
    }
}
