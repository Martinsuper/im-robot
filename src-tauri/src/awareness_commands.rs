//! Foreground sensing settings and state IPC adapters.
use crate::rhythm::emit_work_rhythm_updated;
use serde_json::json;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::State;

#[tauri::command]
pub(crate) fn get_foreground_app_state(
    awareness: State<'_, crate::app_awareness::ForegroundAppState>,
) -> Result<serde_json::Value, String> {
    let category = awareness
        .current_category
        .lock()
        .map_err(|_| "无法读取前台应用状态".to_string())?;
    let sensing_paused = awareness
        .sensing_paused
        .lock()
        .map_err(|_| "无法读取感知状态".to_string())?;
    let app_name = awareness
        .last_app_name
        .lock()
        .map_err(|_| "无法读取应用名称".to_string())?;

    Ok(json!({
        "category": format!("{:?}", category),
        "appName": app_name.as_deref().unwrap_or(""),
        "sensingPaused": *sensing_paused,
    }))
}

#[tauri::command]
pub(crate) fn toggle_foreground_sensing(
    app: AppHandle,
    awareness: State<'_, crate::app_awareness::ForegroundAppState>,
    paused: bool,
) -> Result<(), String> {
    let mut sensing_paused = awareness
        .sensing_paused
        .lock()
        .map_err(|_| "无法设置感知状态".to_string())?;
    *sensing_paused = paused;
    let _ = app.emit("foreground-sensing-changed", json!({ "paused": paused }));
    emit_work_rhythm_updated(&app);
    Ok(())
}
