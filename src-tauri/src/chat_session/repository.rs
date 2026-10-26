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
    let mut sessions = storage::read(&path)?;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("agent");
    backfill_conversation_links_at(&path, &directory, &mut sessions)?;
    Ok(sessions)
}

// Persist legacy task associations before the bounded task journal evicts them.
fn backfill_conversation_links_at(
    path: &std::path::Path,
    agent_directory: &std::path::Path,
    sessions: &mut Vec<chat_session::ChatSession>,
) -> Result<(), String> {
    let marker = path.with_extension("conversation-links-v1.json");
    let migrated: serde_json::Value = storage::read(&marker)?;
    if migrated
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .is_some_and(|version| version >= 1)
    {
        return Ok(());
    }
    let records = crate::agent::journal::TaskJournal::new(agent_directory).all()?;
    let links = records
        .iter()
        .map(|record| (record.request_id.as_str(), record.conversation_id.as_str()))
        .collect();
    if chat_session::backfill_conversation_links(sessions, &links) {
        let backup = path.with_extension("before-conversation-links.json");
        if !backup.exists() {
            std::fs::copy(path, &backup).map_err(|e| format!("无法备份会话关联：{e}"))?;
        }
        storage::write(path, sessions)?;
    }
    storage::write(&marker, &serde_json::json!({"version": 1}))?;
    Ok(())
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

pub(crate) fn try_read_chat_history(app: &AppHandle) -> Result<Vec<ChatHistoryEntry>, String> {
    Ok(chat_session::entries_view(&load_chat_sessions(app, true)?))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::journal::TaskJournal;

    #[test]
    fn legacy_links_are_backed_up_and_survive_journal_eviction() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("chat-sessions.json");
        let journal = TaskJournal::new(directory.path());
        journal.start("first", "passport-test", 1).unwrap();
        journal
            .event("first", &serde_json::json!({"type":"completed"}), 2)
            .unwrap();
        let entry = ChatHistoryEntry {
            conversation_id: None,
            id: "first".into(),
            prompt: "旧问题".into(),
            response: "旧回答".into(),
            created_at: 1,
        };
        let mut sessions = chat_session::sessions_from_entries(&[entry]);
        storage::write(&path, &sessions).unwrap();
        let original = std::fs::read(&path).unwrap();
        backfill_conversation_links_at(&path, directory.path(), &mut sessions).unwrap();
        let backup = path.with_extension("before-conversation-links.json");
        assert_eq!(std::fs::read(&backup).unwrap(), original);
        for index in 0..110 {
            let id = format!("next-{index}");
            journal
                .start(&id, "another-conversation", index + 3)
                .unwrap();
            journal
                .event(&id, &serde_json::json!({"type":"completed"}), index + 3)
                .unwrap();
        }
        assert!(!journal
            .all()
            .unwrap()
            .iter()
            .any(|task| task.request_id == "first"));
        // Once migrated, reading chats must not consult the journal at all.
        std::fs::write(directory.path().join("tasks.json"), b"{broken").unwrap();
        let mut restored = storage::read(&path).unwrap();
        backfill_conversation_links_at(&path, directory.path(), &mut restored).unwrap();
        let history = chat_session::entries_view(&restored);
        assert_eq!(history[0].conversation_id.as_deref(), Some("passport-test"));
        assert_eq!(history[0].prompt, "旧问题");
        assert_eq!(std::fs::read(&backup).unwrap(), original);
    }

    #[test]
    fn persisted_links_win_over_task_metadata_and_roundtrip_through_exports() {
        let entry = ChatHistoryEntry {
            conversation_id: Some("original".into()),
            id: "request".into(),
            prompt: "问题".into(),
            response: "回答".into(),
            created_at: 1,
        };
        let mut sessions = chat_session::sessions_from_entries(&[entry]);
        let links = std::collections::HashMap::from([("request", "wrong")]);
        assert!(!chat_session::backfill_conversation_links(
            &mut sessions,
            &links
        ));
        let history = chat_session::entries_view(&sessions);
        let exported = serde_json::to_string(&history).unwrap();
        let imported: Vec<ChatHistoryEntry> = serde_json::from_str(&exported).unwrap();
        assert_eq!(
            chat_session::entries_view(&chat_session::sessions_from_entries(&imported))[0]
                .conversation_id
                .as_deref(),
            Some("original")
        );
    }
}
