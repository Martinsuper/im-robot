//! Session persistence, legacy migration and history compatibility view.
use super::{self as chat_session, ChatHistoryEntry};
use crate::storage;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

pub(crate) fn chat_history_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("chat-history.json"))
}

pub(crate) fn chat_sessions_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("chat-sessions.json"))
}

fn chat_migration_marker_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("chat-migration.json"))
}

fn chat_migration_done(app: &AppHandle) -> Result<bool, String> {
    let marker = chat_migration_marker_path(app).ok_or("无法获取对话迁移标记路径")?;
    let value: serde_json::Value = storage::read_or_default(&marker);
    Ok(value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .is_some_and(|version| version >= chat_session::SCHEMA_VERSION as u64))
}

pub(crate) fn migrate_chat_sessions(
    app: &AppHandle,
) -> Result<chat_session::ChatMigrationReport, String> {
    let _transaction = storage::transaction();
    let history = chat_history_path(app).ok_or("无法获取对话历史路径")?;
    let sessions = chat_sessions_path(app).ok_or("无法获取会话存储路径")?;
    let marker = chat_migration_marker_path(app).ok_or("无法获取对话迁移标记路径")?;
    chat_session::migrate_legacy_chat_at(&history, &sessions, &marker)
}

/// 读会话存储。语义与 `load_schedule_items` 一致：
/// 读路径允许在迁移失败时降级为只读旧文件；写路径拒绝在迁移未完成时写入。
pub(crate) fn load_chat_sessions(
    app: &AppHandle,
    allow_legacy_fallback: bool,
) -> Result<Vec<chat_session::ChatSession>, String> {
    let _transaction = storage::transaction();
    if !chat_migration_done(app)? {
        match migrate_chat_sessions(app) {
            Ok(_) => {}
            Err(error) if allow_legacy_fallback => {
                eprintln!("[chat] 迁移未完成，读取降级为旧历史（只读）：{error}");
                let history = chat_history_path(app).ok_or("无法获取对话历史路径")?;
                return chat_session::legacy_projection_at(&history);
            }
            Err(error) => return Err(error),
        }
    }
    let path = chat_sessions_path(app).ok_or("无法获取会话存储路径")?;
    storage::read(&path)
}

pub(crate) fn persist_chat_sessions(
    app: &AppHandle,
    sessions: &[chat_session::ChatSession],
) -> Result<(), String> {
    let path = chat_sessions_path(app).ok_or("无法获取会话存储路径")?;
    storage::write(&path, sessions)?;
    let _ = app.emit("chat-sessions-updated", ());
    Ok(())
}

/// 旧的扁平视图。签名不变，因此 chat.rs / 面板 / 导出都无需改动。
pub(crate) fn read_chat_history(app: &AppHandle) -> Vec<ChatHistoryEntry> {
    match load_chat_sessions(app, true) {
        Ok(sessions) => chat_session::entries_view(&sessions),
        Err(error) => {
            eprintln!("[chat] 读取对话历史失败：{error}");
            Vec::new()
        }
    }
}

pub(crate) fn persist_chat_history(
    app: &AppHandle,
    history: &[ChatHistoryEntry],
) -> Result<(), String> {
    let _transaction = storage::transaction();
    let mut sessions = chat_session::sessions_from_entries(history);
    chat_session::trim_sessions(&mut sessions);
    persist_chat_sessions(app, &sessions)
}

/// 追加一轮问答。
///
/// 保留策略从「最多 50 轮」改为「最多 200 个会话」（02 §13）：以会话为单位保留，
/// 才不会出现「聊到一半的会话被截断」。
pub(crate) fn append_chat_history(app: &AppHandle, entry: ChatHistoryEntry) -> Result<(), String> {
    let _transaction = storage::transaction();
    let mut sessions = load_chat_sessions(app, false)?;
    chat_session::append_entry_to_sessions(&mut sessions, &entry);
    persist_chat_sessions(app, &sessions)
}
