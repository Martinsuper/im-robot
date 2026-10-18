//! Session and history IPC adapters, including source lifecycle cleanup.
use super::{self as chat_session, repository::*, ChatHistoryEntry};
use crate::memory;
use crate::storage;
use crate::runtime_types::ChatContext;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
pub(crate) fn list_chat_sessions(app: AppHandle) -> Result<Vec<chat_session::ChatSession>, String> {
    let mut sessions = load_chat_sessions(&app, true)?;
    // 最近更新的在前，与「记录」页的展示顺序一致。
    sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at));
    Ok(sessions)
}

#[tauri::command]
pub(crate) fn delete_chat_session(app: AppHandle, id: String) -> Result<(), String> {
    let _transaction = storage::transaction();
    let mut sessions = load_chat_sessions(&app, false)?;
    let before = sessions.len();
    let removed: Vec<_> = sessions
        .iter()
        .filter(|session| session.id == id)
        .cloned()
        .collect();
    let mut sources: Vec<String> = chat_session::entries_view(&removed)
        .into_iter()
        .map(|entry| entry.id)
        .collect();
    sources.extend(removed.iter().map(|session| session.id.clone()));
    if !sources.is_empty() {
        let db = app.state::<Arc<memory::MemoryDb>>();
        let mut conn = db.0.lock().map_err(|_| "storage_unavailable")?;
        memory::soul::lifecycle::delete_sources(
            &mut conn,
            &sources,
            chrono::Utc::now().timestamp(),
        )?;
    }
    sessions.retain(|session| session.id != id);
    if sessions.len() == before {
        return Err("这个会话已不存在，请刷新后重试".to_string());
    }
    persist_chat_sessions(&app, &sessions)?;
    memory::soul::commands::reconcile_visible(&app);
    let _ = app.emit_to("panel", "chat-history-updated", ());
    Ok(())
}

#[tauri::command]
pub(crate) fn list_chat_history(app: AppHandle) -> Vec<ChatHistoryEntry> {
    read_chat_history(&app)
}

#[tauri::command]
pub(crate) fn clear_chat_history(
    app: AppHandle,
    context: State<'_, ChatContext>,
) -> Result<(), String> {
    let _transaction = storage::transaction();
    context
        .0
        .lock()
        .map_err(|_| "无法清除当前对话上下文".to_string())?
        .clear();
    let sessions = load_chat_sessions(&app, false)?;
    let mut sources: Vec<String> = chat_session::entries_view(&sessions)
        .into_iter()
        .map(|entry| entry.id)
        .collect();
    sources.extend(sessions.iter().map(|session| session.id.clone()));
    if !sources.is_empty() {
        let db = app.state::<Arc<memory::MemoryDb>>();
        let mut conn = db.0.lock().map_err(|_| "storage_unavailable")?;
        memory::soul::lifecycle::delete_sources(
            &mut conn,
            &sources,
            chrono::Utc::now().timestamp(),
        )?;
    }
    persist_chat_history(&app, &[])?;
    memory::soul::commands::reconcile_visible(&app);
    let _ = app.emit_to("panel", "chat-history-updated", ());
    Ok(())
}

#[tauri::command]
pub(crate) fn clear_chat_context(context: State<'_, ChatContext>) -> Result<(), String> {
    context
        .0
        .lock()
        .map_err(|_| "无法清除当前对话上下文".to_string())?
        .clear();
    Ok(())
}

#[tauri::command]
pub(crate) fn get_bubble_chat_history(
    app: AppHandle,
    context: State<'_, ChatContext>,
) -> Result<Vec<ChatHistoryEntry>, String> {
    let mut entries = context
        .0
        .lock()
        .map_err(|_| "无法读取对话历史".to_string())?
        .clone();
    for entry in read_chat_history(&app) {
        if !entries.iter().any(|current| current.id == entry.id) {
            entries.push(entry);
        }
    }
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.created_at));
    entries.truncate(20);
    Ok(entries)
}
