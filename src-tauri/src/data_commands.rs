//! Data cleanup, export and import IPC adapters.
use crate::chat_session::repository::chat_history_path;
use crate::chat_session::repository::chat_sessions_path;
use crate::common::unix_timestamp;
use crate::favorites::html_favorites_path;
use crate::memos::memos_path;
use crate::rhythm::emit_focus_updated;
use crate::rhythm::focus_records_path;
use crate::rhythm::FocusTimer;
use crate::runtime_types::ChatContext;
use crate::schedule::repository::calendar_events_path;
use crate::schedule::repository::reminders_path;
use crate::schedule::repository::schedule_items_path;
use crate::settings::read_settings;
use crate::storage;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tauri::State;

/// 清空我的数据（R4-6）。
///
/// 先把所有数据文件复制到 `backups/cleared-<时间戳>/`，再写回空数组。
/// **不删除**任何文件——旧数据永远有一份留在备份里，这是 08 §1.4「可逆原则」的要求。
/// 只清用户内容（提醒 / 日程 / 备忘 / 对话 / 专注记录），**不动**设置与记忆库
/// （设置是「怎么表现」，清掉会让人莫名其妙；记忆库属 04 模块，单独提供入口）。
#[tauri::command]
pub(crate) async fn clear_my_data(
    app: AppHandle,
    db: State<'_, std::sync::Arc<crate::memory::MemoryDb>>,
) -> Result<serde_json::Value, String> {
    let db = db.inner().clone();
    crate::background::SUPERVISOR
        .blocking("clear-data", move || {
            crate::data_snapshot::transaction(&app, &db, || clear_my_data_inner(app.clone()))
        })
        .await
}
fn clear_my_data_inner(app: AppHandle) -> Result<serde_json::Value, String> {
    let _transaction = storage::transaction();

    let files: Vec<(&str, Option<PathBuf>, serde_json::Value)> = vec![
        (
            "reminders.json",
            reminders_path(&app),
            serde_json::json!([]),
        ),
        (
            "calendar-events.json",
            calendar_events_path(&app),
            serde_json::json!([]),
        ),
        (
            "schedule-items.json",
            schedule_items_path(&app),
            serde_json::json!([]),
        ),
        ("memos.json", memos_path(&app), serde_json::json!([])),
        (
            "html-favorites.json",
            html_favorites_path(&app),
            serde_json::json!([]),
        ),
        (
            "chat-history.json",
            chat_history_path(&app),
            serde_json::json!([]),
        ),
        (
            "chat-sessions.json",
            chat_sessions_path(&app),
            serde_json::json!([]),
        ),
        (
            "focus-records.json",
            focus_records_path(&app),
            serde_json::json!([]),
        ),
    ];

    // 先备份
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("无法获取数据目录：{error}"))?;
    let backup_dir = config_dir.join(format!("backups/cleared-{}", unix_timestamp()));
    let mut backed_up: Vec<String> = Vec::new();
    for (name, path, _) in &files {
        let Some(path) = path else { continue };
        if !path.exists() {
            continue;
        }
        std::fs::create_dir_all(&backup_dir)
            .map_err(|error| format!("无法创建备份目录：{error}"))?;
        std::fs::copy(path, backup_dir.join(name))
            .map_err(|error| format!("无法备份 {name}：{error}"))?;
        backed_up.push(name.to_string());
    }

    // 再清空
    for (name, path, empty) in &files {
        if let Some(path) = path {
            storage::write(path, empty).map_err(|error| {
                format!("清空 {name} 失败：{error}。原文件已恢复，未做任何删除。")
            })?;
        }
    }

    // 内存中的会话上下文也一并清掉
    if let Some(context) = app.try_state::<ChatContext>() {
        if let Ok(mut history) = context.0.lock() {
            history.clear();
        }
    }
    let _ = app.emit("chat-history-updated", ());
    let _ = app.emit("schedule-updated", ());
    let _ = app.emit("memos-updated", ());
    let _ = app.emit("html-favorites-updated", ());

    Ok(serde_json::json!({
        "backupDir": backup_dir.display().to_string(),
        "cleared": backed_up,
    }))
}

#[tauri::command]
pub(crate) fn export_data(app: AppHandle) -> Result<serde_json::Value, String> {
    let export = crate::sync::import_export::build_export_data(&app);
    serde_json::to_value(export).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn export_to_file(app: AppHandle, file_path: String) -> Result<(), String> {
    let path = std::path::Path::new(&file_path);
    crate::sync::import_export::export_to_file(&app, path)
}

#[tauri::command]
pub(crate) fn preview_import(file_path: String) -> Result<serde_json::Value, String> {
    let path = std::path::Path::new(&file_path);
    let preview = crate::sync::import_export::preview_import(path)?;
    serde_json::to_value(preview).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) async fn import_data(
    app: AppHandle,
    db: State<'_, std::sync::Arc<crate::memory::MemoryDb>>,
    focus: State<'_, FocusTimer>,
    file_path: String,
) -> Result<serde_json::Value, String> {
    let owned_app = app.clone();
    let db = db.inner().clone();
    let result = crate::background::SUPERVISOR
        .blocking("import-data", move || {
            crate::data_snapshot::transaction(&owned_app, &db, || {
                crate::sync::import_export::import_from_file(
                    &owned_app,
                    std::path::Path::new(&file_path),
                )
            })
        })
        .await?;
    if result.chats_imported > 0 {
        let _ = app.emit("chat-history-updated", ());
    }
    if result.reminders_imported > 0 {
        let _ = app.emit("reminders-updated", ());
    }
    if result.calendar_imported > 0 {
        let _ = app.emit("calendar-events-updated", ());
    }
    if result.focus_imported > 0 {
        emit_focus_updated(&app, &focus);
    }
    if result.settings_imported {
        let settings = read_settings(&app);
        let _ = app.emit_to("panel", "settings-updated", &settings);
        let _ = app.emit_to("pet", "settings-updated", &settings);
        let _ = app.emit_to("bubble", "settings-updated", &settings);
    }
    serde_json::to_value(result).map_err(|e| e.to_string())
}
