//! R2 · 对话历史按**会话**组织（02 §13）。
//!
//! # 现状与目标
//!
//! 现状是扁平的 `chat-history.json`：每一项是一轮问答 `ChatHistoryEntry { id, prompt,
//! response, createdAt }`。用户看到的是一串孤立的问答对，找不回「上次那件事聊到哪了」。
//!
//! 目标是 `ChatSession { id, title, messages[], createdAt, updatedAt }`：
//! 历史列表展示会话（标题 + 时间 + 消息数），点开可继续对话。
//!
//! # 做法（与 ScheduleItem 同一套）
//!
//! `chat-sessions.json` 成为**唯一写入口**；`ChatHistoryEntry` 退化为它的一个**视图**。
//! 因此 `read_chat_history` / `persist_chat_history` 的签名保持不变，
//! `chat.rs` 的写入路径一行都不用改。
//!
//! # 会话边界
//!
//! 旧数据里没有会话标识，只能推断：**相邻两轮间隔不超过 `SESSION_GAP_SECONDS` 就算同一次会话**。
//! 这是个启发式，但它可解释、可测试，而且比「一轮一个会话」或「全部塞进一个会话」都更接近真实使用。
//!
//! 数据安全与 `schedule` 模块对齐：迁移前备份、幂等、旧文件保留一版、损坏即中止。

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::{storage, unix_timestamp, ChatHistoryEntry};

/// 会话切分的间隔阈值：相邻两轮超过这个间隔就算新会话。
pub(crate) const SESSION_GAP_SECONDS: u64 = 30 * 60;

/// 保留的会话数上限。超出时丢弃最旧的（02 §13：保留最近 200 个会话）。
pub(crate) const MAX_SESSIONS: usize = 200;

/// 会话标题的最大长度。标题取首轮提问，过长则截断。
const TITLE_MAX_CHARS: usize = 40;

pub(crate) const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ChatRole {
    User,
    Assistant,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatMessage {
    pub(crate) role: ChatRole,
    pub(crate) content: String,
    pub(crate) created_at: u64,
    /// 迁移前那一轮问答的原始 id。
    ///
    /// 存它是为了让迁移**无损**：`entries_view` 能还原出与原文件完全一致的 id，
    /// 于是导入导出按 id 去重仍然准，并且在需要时可以逐条对回旧文件。
    /// 新建的消息为 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) source_entry_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatSession {
    pub(crate) id: String,
    /// 自动摘要出的标题（取首轮提问），过长截断。
    pub(crate) title: String,
    pub(crate) messages: Vec<ChatMessage>,
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
}

impl ChatSession {
    /// 首条用户消息的内容，作为标题来源。
    fn title_from_messages(messages: &[ChatMessage]) -> String {
        let first = messages
            .iter()
            .find(|message| message.role == ChatRole::User)
            .map(|message| message.content.as_str())
            .unwrap_or("");
        let flattened = first.split_whitespace().collect::<Vec<_>>().join(" ");
        let mut title: String = flattened.chars().take(TITLE_MAX_CHARS).collect();
        if flattened.chars().count() > TITLE_MAX_CHARS {
            title.push('…');
        }
        if title.is_empty() {
            title = "未命名对话".to_string();
        }
        title
    }

    fn message_count(&self) -> usize {
        self.messages.len()
    }
}

/// 把一轮问答摊平成两条消息。
fn messages_from_entry(entry: &ChatHistoryEntry) -> [ChatMessage; 2] {
    [
        ChatMessage {
            role: ChatRole::User,
            content: entry.prompt.clone(),
            created_at: entry.created_at,
            source_entry_id: None,
        },
        ChatMessage {
            role: ChatRole::Assistant,
            content: entry.response.clone(),
            // 回答与提问同一轮，时间上取同一秒即可；顺序由数组位置保证。
            created_at: entry.created_at,
            source_entry_id: Some(entry.id.clone()),
        },
    ]
}

/// 会话 → 扁平视图。`ChatHistoryEntry.id` 用会话 id + 轮次序号拼出，保持稳定。
pub(crate) fn entries_view(sessions: &[ChatSession]) -> Vec<ChatHistoryEntry> {
    let mut entries = Vec::new();
    for session in sessions {
        let mut index = 0usize;
        let mut pending_prompt: Option<&ChatMessage> = None;
        for message in &session.messages {
            match message.role {
                ChatRole::User => pending_prompt = Some(message),
                ChatRole::Assistant => {
                    let prompt = pending_prompt.take();
                    entries.push(ChatHistoryEntry {
                        // 优先用原始 id，保证迁移无损；没有时（新会话）才合成
                        id: message
                            .source_entry_id
                            .clone()
                            .unwrap_or_else(|| format!("{}-{}", session.id, index)),
                        prompt: prompt.map(|item| item.content.clone()).unwrap_or_default(),
                        response: message.content.clone(),
                        created_at: message.created_at,
                    });
                    index += 1;
                }
            }
        }
        // 只有提问还没有回答的那一轮也要能被看见（对话进行到一半就退出）
        if let Some(prompt) = pending_prompt {
            entries.push(ChatHistoryEntry {
                id: format!("{}-{}", session.id, index),
                prompt: prompt.content.clone(),
                response: String::new(),
                created_at: prompt.created_at,
            });
        }
    }
    // 旧的扁平结构是「最新的在前」，视图保持一致，避免调用方行为变化。
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.created_at));
    entries
}

/// 由旧扁平历史推断会话（迁移用）。
pub(crate) fn sessions_from_entries(entries: &[ChatHistoryEntry]) -> Vec<ChatSession> {
    let mut ordered: Vec<&ChatHistoryEntry> = entries.iter().collect();
    ordered.sort_by_key(|entry| entry.created_at);

    let mut sessions: Vec<ChatSession> = Vec::new();
    for entry in ordered {
        match sessions.last_mut() {
            Some(current) if entry.created_at.saturating_sub(current.updated_at) <= SESSION_GAP_SECONDS => {
                current.messages.extend(messages_from_entry(entry));
                current.updated_at = entry.created_at.max(current.updated_at);
            }
            _ => {
                let messages = messages_from_entry(entry).to_vec();
                sessions.push(ChatSession {
                    id: format!("session-{}", entry.created_at),
                    title: ChatSession::title_from_messages(&messages),
                    messages,
                    created_at: entry.created_at,
                    updated_at: entry.created_at,
                });
            }
        }
    }
    sessions
}

/// 追加一轮问答。与上一轮间隔在阈值内就并入同一会话，否则新开一个。
pub(crate) fn append_entry_to_sessions(
    sessions: &mut Vec<ChatSession>,
    entry: &ChatHistoryEntry,
) -> (String, usize) {
    let messages = messages_from_entry(entry).to_vec();
    let session_id = match sessions.last_mut() {
        Some(current) if entry.created_at.saturating_sub(current.updated_at) <= SESSION_GAP_SECONDS => {
            current.messages.extend(messages);
            current.updated_at = entry.created_at.max(current.updated_at);
            current.id.clone()
        }
        _ => {
            let id = format!("session-{}", entry.created_at);
            sessions.push(ChatSession {
                id: id.clone(),
                title: ChatSession::title_from_messages(&messages),
                messages,
                created_at: entry.created_at,
                updated_at: entry.created_at,
            });
            id
        }
    };
    trim_sessions(sessions);
    let index = sessions
        .iter()
        .find(|session| session.id == session_id)
        .map(ChatSession::message_count)
        .unwrap_or_default();
    (session_id, index)
}

/// 只保留最新的 `MAX_SESSIONS` 个会话。
pub(crate) fn trim_sessions(sessions: &mut Vec<ChatSession>) {
    sessions.sort_by_key(|session| session.updated_at);
    while sessions.len() > MAX_SESSIONS {
        sessions.remove(0);
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatMigrationReport {
    pub already_migrated: bool,
    pub sessions_imported: usize,
    pub entries_imported: usize,
    pub backup_dir: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationMarker {
    version: u32,
    migrated_at: u64,
    sessions: usize,
    entries: usize,
}

/// 迁移的路径级实现，与 `AppHandle` 解耦，便于单测。
pub(crate) fn migrate_legacy_chat_at(
    history_path: &Path,
    sessions_path: &Path,
    marker_path: &Path,
) -> Result<ChatMigrationReport, String> {
    let marker: MigrationMarker = storage::read_or_default(marker_path);
    if marker.version >= SCHEMA_VERSION {
        return Ok(ChatMigrationReport {
            already_migrated: true,
            sessions_imported: marker.sessions,
            entries_imported: marker.entries,
            backup_dir: None,
        });
    }

    if sessions_path.exists() {
        let existing: Vec<ChatSession> = storage::read(sessions_path)?;
        if !existing.is_empty() {
            return Err(format!(
                "{} 已有 {} 个会话但缺少迁移标记，为避免覆盖已中止迁移。\
                 请人工确认保留哪一份后删除另一个文件。",
                sessions_path.display(),
                existing.len()
            ));
        }
    }

    // 用 storage::read 而不是 read_or_default：旧文件损坏时必须中止，
    // 否则会把「读不出来」当成「没有历史」，迁移出 0 条并写下完成标记。
    let entries: Vec<ChatHistoryEntry> = storage::read(history_path)?;
    let mut sessions = sessions_from_entries(&entries);
    trim_sessions(&mut sessions);

    let backup_dir = backup_legacy_history(history_path, sessions_path.parent())?;

    storage::write(sessions_path, &sessions)?;
    storage::write(
        marker_path,
        &MigrationMarker {
            version: SCHEMA_VERSION,
            migrated_at: unix_timestamp(),
            sessions: sessions.len(),
            entries: entries.len(),
        },
    )?;

    Ok(ChatMigrationReport {
        already_migrated: false,
        sessions_imported: sessions.len(),
        entries_imported: entries.len(),
        backup_dir,
    })
}

fn backup_legacy_history(history_path: &Path, base_dir: Option<&Path>) -> Result<Option<String>, String> {
    let Some(base_dir) = base_dir else {
        return Ok(None);
    };
    if !history_path.exists() {
        return Ok(None);
    }
    let directory: PathBuf = base_dir.join(format!("backups/chat-r2-{}", unix_timestamp()));
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建备份目录：{error}"))?;
    let name = history_path.file_name().ok_or("备份文件名无效")?;
    fs::copy(history_path, directory.join(name))
        .map_err(|error| format!("无法备份对话历史：{error}"))?;
    Ok(Some(directory.display().to_string()))
}

/// 迁移未完成时的**只读**兜底：把旧扁平历史直接摊成会话。
pub(crate) fn legacy_projection_at(history_path: &Path) -> Result<Vec<ChatSession>, String> {
    let entries: Vec<ChatHistoryEntry> = storage::read(history_path)?;
    Ok(sessions_from_entries(&entries))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(created_at: u64, prompt: &str) -> ChatHistoryEntry {
        ChatHistoryEntry {
            id: format!("entry-{created_at}"),
            prompt: prompt.to_string(),
            response: format!("回答：{prompt}"),
            created_at,
        }
    }

    struct Fixture {
        _directory: tempfile::TempDir,
        history: PathBuf,
        sessions: PathBuf,
        marker: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path();
            Self {
                history: root.join("chat-history.json"),
                sessions: root.join("chat-sessions.json"),
                marker: root.join("chat-migration.json"),
                _directory: directory,
            }
        }

        fn migrate(&self) -> Result<ChatMigrationReport, String> {
            migrate_legacy_chat_at(&self.history, &self.sessions, &self.marker)
        }

        fn write_history(&self, entries: serde_json::Value) {
            fs::write(&self.history, entries.to_string()).unwrap();
        }

        fn read_sessions(&self) -> Vec<ChatSession> {
            storage::read(&self.sessions).unwrap()
        }
    }

    #[test]
    fn groups_nearby_exchanges_into_one_session() {
        // 三轮都在半小时内 → 一个会话；第四轮隔了两小时 → 新会话
        let entries = vec![
            entry(1000, "第一问"),
            entry(1000 + 60, "第二问"),
            entry(1000 + 120, "第三问"),
            entry(1000 + 8000, "很久之后的问"),
        ];
        let sessions = sessions_from_entries(&entries);
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].messages.len(), 6, "三轮 = 6 条消息");
        assert_eq!(sessions[1].messages.len(), 2);
    }

    #[test]
    fn session_title_comes_from_the_first_user_message() {
        let sessions = sessions_from_entries(&[entry(1000, "  帮我总结一下这段文字  ")]);
        assert_eq!(sessions[0].title, "帮我总结一下这段文字");
    }

    #[test]
    fn long_titles_are_truncated_with_an_ellipsis() {
        let long = "很长的提问".repeat(20);
        let sessions = sessions_from_entries(&[entry(1000, &long)]);
        assert!(sessions[0].title.chars().count() <= TITLE_MAX_CHARS + 1);
        assert!(sessions[0].title.ends_with('…'));
    }

    #[test]
    fn empty_prompt_falls_back_to_a_placeholder_title() {
        let sessions = sessions_from_entries(&[entry(1000, "   ")]);
        assert_eq!(sessions[0].title, "未命名对话");
    }

    #[test]
    fn view_projects_sessions_back_to_flat_entries_newest_first() {
        let sessions = sessions_from_entries(&[entry(1000, "早"), entry(1000 + 50, "晚")]);
        let entries = entries_view(&sessions);
        assert_eq!(entries.len(), 2);
        // 与旧扁平结构一致：最新的在前
        assert_eq!(entries[0].prompt, "晚");
        assert_eq!(entries[0].response, "回答：晚");
        assert_eq!(entries[1].prompt, "早");
    }

    #[test]
    fn view_keeps_a_pending_question_without_an_answer() {
        let mut sessions = sessions_from_entries(&[entry(1000, "已答")]);
        sessions[0].messages.push(ChatMessage {
            role: ChatRole::User,
            content: "还没回答".into(),
            created_at: 1060,
            source_entry_id: None,
        });
        let entries = entries_view(&sessions);
        let pending = entries.iter().find(|item| item.prompt == "还没回答").unwrap();
        assert_eq!(pending.response, "");
    }

    #[test]
    fn view_restores_the_original_entry_ids_so_migration_is_lossless() {
        let original = vec![entry(1000, "一问"), entry(2000, "二问")];
        let sessions = sessions_from_entries(&original);
        let restored = entries_view(&sessions);
        let mut original_ids: Vec<&str> = original.iter().map(|item| item.id.as_str()).collect();
        let mut restored_ids: Vec<&str> = restored.iter().map(|item| item.id.as_str()).collect();
        original_ids.sort_unstable();
        restored_ids.sort_unstable();
        assert_eq!(restored_ids, original_ids, "往返后 id 必须一致，否则导入去重会失准");
    }

    #[test]
    fn appending_within_the_gap_joins_the_current_session() {
        let mut sessions = sessions_from_entries(&[entry(1000, "第一问")]);
        let (id, count) = append_entry_to_sessions(&mut sessions, &entry(1000 + 300, "第二问"));
        assert_eq!(sessions.len(), 1, "间隔内应并入同一会话");
        assert_eq!(id, sessions[0].id);
        assert_eq!(count, 4);
        assert_eq!(sessions[0].title, "第一问", "标题不因为追加而改变");
    }

    #[test]
    fn appending_beyond_the_gap_starts_a_new_session() {
        let mut sessions = sessions_from_entries(&[entry(1000, "第一问")]);
        append_entry_to_sessions(&mut sessions, &entry(1000 + SESSION_GAP_SECONDS + 1, "隔了很久"));
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[1].title, "隔了很久");
    }

    #[test]
    fn sessions_are_capped_at_the_limit_keeping_the_newest() {
        let mut sessions: Vec<ChatSession> = Vec::new();
        for index in 0..(MAX_SESSIONS + 5) {
            // 每次都超出一个间隔，强制新开会话
            append_entry_to_sessions(
                &mut sessions,
                &entry(1000 + index as u64 * (SESSION_GAP_SECONDS + 10), &format!("第 {index} 问")),
            );
        }
        assert_eq!(sessions.len(), MAX_SESSIONS);
        assert!(sessions.last().unwrap().title.contains(&format!("第 {}", MAX_SESSIONS + 4)));
    }

    #[test]
    fn migration_is_idempotent_and_backs_up_the_legacy_file() {
        let fixture = Fixture::new();
        let original = json!([{
            "id": "entry-1", "prompt": "你好", "response": "你好呀", "createdAt": 1000
        }]);
        fixture.write_history(original.clone());
        let original_bytes = fs::read(&fixture.history).unwrap();

        let first = fixture.migrate().unwrap();
        assert!(!first.already_migrated);
        assert_eq!(first.sessions_imported, 1);
        assert_eq!(first.entries_imported, 1);
        let backup = PathBuf::from(first.backup_dir.clone().unwrap());
        assert_eq!(fs::read(backup.join("chat-history.json")).unwrap(), original_bytes);

        let second = fixture.migrate().unwrap();
        assert!(second.already_migrated, "第二次必须是空操作");
        assert_eq!(fixture.read_sessions().len(), 1, "不应重复导入");
    }

    #[test]
    fn corrupt_legacy_history_aborts_without_marker() {
        let fixture = Fixture::new();
        fs::write(&fixture.history, "{broken").unwrap();
        assert!(fixture.migrate().is_err());
        assert!(!fixture.marker.exists(), "失败时绝不能写下完成标记");
        assert!(!fixture.sessions.exists(), "失败时不应留下半截文件");
    }

    #[test]
    fn refuses_to_clobber_existing_sessions_without_marker() {
        let fixture = Fixture::new();
        fixture.write_history(json!([]));
        fs::write(
            &fixture.sessions,
            json!([{ "id": "session-9", "title": "已有会话", "messages": [],
                     "createdAt": 900, "updatedAt": 900 }])
            .to_string(),
        )
        .unwrap();
        let error = fixture.migrate().unwrap_err();
        assert!(error.contains("为避免覆盖"), "{error}");
        assert!(fs::read_to_string(&fixture.sessions).unwrap().contains("session-9"));
    }

    #[test]
    fn fresh_install_migrates_to_empty() {
        let fixture = Fixture::new();
        let report = fixture.migrate().unwrap();
        assert_eq!(report.sessions_imported, 0);
        assert!(report.backup_dir.is_none());
        assert!(fixture.read_sessions().is_empty());
    }

    #[test]
    fn legacy_projection_is_read_only() {
        let fixture = Fixture::new();
        fixture.write_history(json!([{
            "id": "entry-1", "prompt": "旧问", "response": "旧答", "createdAt": 1000
        }]));
        let sessions = legacy_projection_at(&fixture.history).unwrap();
        assert_eq!(sessions.len(), 1);
        assert!(!fixture.sessions.exists());
        assert!(!fixture.marker.exists());
    }

    #[test]
    fn legacy_projection_reports_corruption_instead_of_pretending_empty() {
        let fixture = Fixture::new();
        fs::write(&fixture.history, "{broken").unwrap();
        assert!(legacy_projection_at(&fixture.history).is_err());
    }
}
