//! System calendar synchronization IPC adapters.
use crate::calendar_service::read_calendar_events;
use serde_json::json;
use tauri::AppHandle;
use tauri::Emitter;

#[tauri::command]
pub(crate) fn get_calendar_sync_status(app: AppHandle) -> Result<serde_json::Value, String> {
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
pub(crate) async fn sync_calendar_to_system(app: AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let events = read_calendar_events(&app);
        let result = crate::sync::calendar_sync::push_to_system_calendar(&app, &events)?;
        let _ = app.emit_to("panel", "calendar-sync-updated", ());
        Ok(json!({
            "pushed": result.pushed,
            "mappingCount": result.mappings.len(),
        }))
    })
    .await
    .map_err(|_| "日历同步任务发生异常，请核对同步结果后再重试".to_string())?
}

#[tauri::command]
pub(crate) async fn sync_calendar_from_system(app: AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|_| "日历同步任务发生异常，请核对同步结果后再重试".to_string())?
}
