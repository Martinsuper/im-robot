//! Durable, local conversation extraction. Model answers are never treated as facts.
use super::{MemoryCandidate, MemoryDb};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionStatus {
    pub enabled: bool,
    pub interval_minutes: u64,
    pub last_run_at: u64,
    pub processed_count: u64,
    pub pending_count: u64,
}

fn initialize(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS memory_extraction_settings (
        id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 1,
        interval_minutes INTEGER NOT NULL DEFAULT 30, last_run_at INTEGER NOT NULL DEFAULT 0);
        INSERT OR IGNORE INTO memory_extraction_settings(id) VALUES(1);
        CREATE TABLE IF NOT EXISTS memory_extraction_processed (entry_id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS memory_extraction_candidates (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS memory_extraction_seen (fingerprint TEXT PRIMARY KEY);",
    )
    .map_err(|e| e.to_string())
}

pub fn status(db: &MemoryDb) -> Result<ExtractionStatus, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    initialize(&conn)?;
    conn.query_row(
        "SELECT enabled, interval_minutes, last_run_at,
        (SELECT COUNT(*) FROM memory_extraction_processed),
        (SELECT COUNT(*) FROM memory_extraction_candidates)
        FROM memory_extraction_settings WHERE id=1",
        [],
        |r| {
            Ok(ExtractionStatus {
                enabled: r.get(0)?,
                interval_minutes: r.get(1)?,
                last_run_at: r.get(2)?,
                processed_count: r.get(3)?,
                pending_count: r.get(4)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

pub fn pending(db: &MemoryDb) -> Result<Vec<MemoryCandidate>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    initialize(&conn)?;
    let mut stmt = conn
        .prepare("SELECT payload FROM memory_extraction_candidates ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|r| serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string()))
        .collect()
}

pub fn remove_candidate(db: &MemoryDb, id: &str) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    initialize(&conn)?;
    conn.execute("DELETE FROM memory_extraction_candidates WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Conservative sentence extraction; questions, requests, and assistant answers are excluded.
fn conversation_candidates(prompt: &str) -> Vec<MemoryCandidate> {
    if super::policy::contains_sensitive_content(prompt) {
        return Vec::new();
    }
    prompt
        .split(['。', '！', '!', '\n', ';', '；'])
        .filter_map(|sentence| {
            let statement = sentence
                .trim()
                .trim_start_matches("请记住")
                .trim_start_matches("记住")
                .trim_start_matches(['：', ':', '，', ',', ' '])
                .trim();
            let lower = statement.to_lowercase();
            let markers = [
                "我喜欢",
                "我不喜欢",
                "我讨厌",
                "我习惯",
                "我偏好",
                "我叫",
                "我住在",
                "我的名字是",
                "我每天",
                "我经常",
                "我总是",
                "我从不",
                "i like ",
                "i dislike ",
                "i prefer ",
                "my name is ",
                "i live in ",
            ];
            if statement.chars().count() < 5
                || statement.chars().count() > 500
                || statement.contains(['?', '？'])
                || !markers.iter().any(|marker| lower.starts_with(marker))
            {
                return None;
            }
            Some(MemoryCandidate {
                id: String::new(),
                title: format!(
                    "用户事实：{}",
                    statement.chars().take(24).collect::<String>()
                ),
                content: statement.to_string(),
                memory_type: super::MemoryType::Profile,
                source: super::MemorySource::Conversation,
                confidence: 0.7,
                importance: 5,
                tags: vec!["自动提取".into()],
                requires_confirmation: true,
            })
        })
        .collect()
}

/// Commit candidates and source IDs together: crash/retry cannot re-extract rejected facts.
#[cfg(test)]
fn extract(db: &MemoryDb, entries: &[crate::chat_session::ChatHistoryEntry], now: u64, force: bool) -> Result<usize, String> {
    extract_with_topics(db, entries, now, force, None)
}

fn extract_with_topics(
    db: &MemoryDb,
    entries: &[crate::chat_session::ChatHistoryEntry],
    now: u64,
    force: bool,
    topic_timezone: Option<&str>,
) -> Result<usize, String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    initialize(&conn)?;
    // A failed/unsupported soul migration must not disable ordinary extraction.
    let topic_timezone = topic_timezone.filter(|_| super::soul::store::ensure_available(&conn).is_ok());
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let (enabled, interval, last): (bool, u64, u64) = tx.query_row(
        "SELECT enabled, interval_minutes, last_run_at FROM memory_extraction_settings WHERE id=1",
        [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(|e| e.to_string())?;
    if !force && (!enabled || (last != 0 && now >= last && now - last < interval * 60)) {
        return Ok(0);
    }
    let mut count = 0;
    let mut processed = 0;
    for entry in entries {
        let exists = tx
            .query_row(
                "SELECT 1 FROM memory_extraction_processed WHERE entry_id=?1",
                [&entry.id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .is_some();
        if exists {
            continue;
        }
        // Only user statements; assistant claims of successful actions are unverified.
        for (index, mut candidate) in conversation_candidates(&entry.prompt)
            .into_iter()
            .enumerate()
        {
            candidate.id = format!("auto-{}-{}", entry.id, index);
            let fresh = tx
                .execute(
                    "INSERT OR IGNORE INTO memory_extraction_seen(fingerprint) VALUES(?1)",
                    [format!(
                        "{:x}",
                        Sha256::digest(candidate.content.as_bytes())
                    )],
                )
                .map_err(|e| e.to_string())?;
            if fresh == 0 {
                continue;
            }
            let payload = serde_json::to_string(&candidate).map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT OR IGNORE INTO memory_extraction_candidates(id,payload) VALUES(?1,?2)",
                params![candidate.id, payload],
            )
            .map_err(|e| e.to_string())?;
            count += 1;
        }
        // Manual memory extraction may bypass its timer, but must never bypass
        // the user's disabled setting for generating new open-topic candidates.
        if enabled {
            if let Some(timezone) = topic_timezone {
                let topic_now = i64::try_from(now).map_err(|_| "invalid_extraction_time")?;
                count += super::soul::open_loops::enqueue(&tx, entry, topic_now, timezone)?;
            }
        }
        tx.execute(
            "INSERT INTO memory_extraction_processed(entry_id) VALUES(?1)",
            [&entry.id],
        )
        .map_err(|e| e.to_string())?;
        processed += 1;
        if processed >= 100 {
            break;
        }
    }
    // Drain large backlogs on subsequent minute ticks rather than waiting a full interval.
    {
        let completed_at = if processed < 100 { now } else { 0 };
        tx.execute(
            "UPDATE memory_extraction_settings SET last_run_at=?1 WHERE id=1",
            [completed_at],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(count)
}

fn run(app: &AppHandle, force: bool) -> Result<usize, String> {
    // Preserve load failures as errors; an empty history must not advance the schedule on failure.
    let sessions = crate::chat_session::repository::load_chat_sessions(app, true)?;
    let entries = crate::chat_session::entries_view(&sessions);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let db = app.state::<Arc<MemoryDb>>();
    let soul_ready = app.try_state::<super::soul::model::SoulBootStatus>()
        .is_some_and(|state| state.0);
    let timezone = if soul_ready { iana_time_zone::get_timezone().ok() } else { None };
    let count = extract_with_topics(&db, &entries, now, force, timezone.as_deref())?;
    if count > 0 {
        let _ = app.emit(
            "memory-captured",
            crate::runtime_types::MemoryCapturedEvent {
                confirmed: 0,
                pending: count,
            },
        );
        let _ = app.emit_to("panel", "memories-updated", ());
    }
    Ok(count)
}

pub fn start(app: AppHandle) {
    // One worker serializes all automatic passes; missed intervals catch up on startup.
    tauri::async_runtime::spawn(async move {
        loop {
            let handle = app.clone();
            match tauri::async_runtime::spawn_blocking(move || run(&handle, false)).await {
                Ok(Ok(_)) => {}
                result => eprintln!("[memory] 自动提取失败，下次重试：{result:?}"),
            }
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
    });
}

#[tauri::command]
pub fn get_memory_extraction_status(
    db: State<'_, Arc<MemoryDb>>,
) -> Result<ExtractionStatus, String> {
    status(&db)
}

#[tauri::command]
pub fn configure_memory_extraction(
    db: State<'_, Arc<MemoryDb>>,
    enabled: bool,
    interval_minutes: u64,
) -> Result<ExtractionStatus, String> {
    if !(1..=1440).contains(&interval_minutes) {
        return Err("提取间隔需为 1–1440 分钟".into());
    }
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        initialize(&conn)?;
        conn.execute(
            "UPDATE memory_extraction_settings SET enabled=?1, interval_minutes=?2 WHERE id=1",
            params![enabled, interval_minutes],
        )
        .map_err(|e| e.to_string())?;
    }
    status(&db)
}

#[tauri::command]
pub async fn extract_memories_now(app: AppHandle) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || run(&app, true))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(id: &str, prompt: &str) -> crate::chat_session::ChatHistoryEntry {
        crate::chat_session::ChatHistoryEntry {
            id: id.into(),
            prompt: prompt.into(),
            response: "已完成支付".into(),
            created_at: 10,
        }
    }
    #[test]
    fn extraction_is_durable_idempotent_and_user_grounded() {
        let db = super::super::open_in_memory_db().unwrap();
        let entries = vec![entry("a", "我喜欢早上喝咖啡。"), entry("b", "你好")];
        assert_eq!(extract(&db, &entries, 100, false).unwrap(), 1);
        let candidates = pending(&db).unwrap();
        assert_eq!(candidates.len(), 1);
        assert!(candidates[0].requires_confirmation);
        remove_candidate(&db, &candidates[0].id).unwrap();
        assert_eq!(extract(&db, &entries, 2000, true).unwrap(), 0);
        assert!(pending(&db).unwrap().is_empty());
        assert_eq!(status(&db).unwrap().processed_count, 2);
    }
    #[test]
    fn interval_disable_sensitive_and_batch_limit() {
        let db = super::super::open_in_memory_db().unwrap();
        extract(&db, &[], 100, false).unwrap();
        assert_eq!(
            extract(&db, &[entry("a", "我喜欢喝茶")], 101, false).unwrap(),
            0
        );
        {
            let conn = db.0.lock().unwrap();
            conn.execute("UPDATE memory_extraction_settings SET enabled=0", [])
                .unwrap();
        }
        assert_eq!(
            extract(&db, &[entry("a", "我喜欢喝茶")], 3000, false).unwrap(),
            0
        );
        assert_eq!(
            extract(
                &db,
                &[entry("secret", "我喜欢这个 api_key=abc")],
                3000,
                true
            )
            .unwrap(),
            0
        );
        let entries: Vec<_> = (0..105).map(|i| entry(&format!("e{i}"), "你好")).collect();
        extract(&db, &entries, 4000, true).unwrap();
        assert_eq!(status(&db).unwrap().processed_count, 101);
        extract(&db, &entries, 4001, true).unwrap();
        assert_eq!(status(&db).unwrap().processed_count, 106);
    }
    #[test]
    fn extracts_multiple_explicit_facts_and_deduplicates_repeated_conversations() {
        let db = super::super::open_in_memory_db().unwrap();
        let entries = vec![
            entry("a", "请记住：我不喜欢喝咖啡。我住在上海。"),
            entry("b", "我住在上海。"),
            entry("c", "我希望你帮我写代码"),
            entry("d", "我喜欢喝咖啡吗？"),
            entry("e", "I prefer tea!"),
        ];
        assert_eq!(extract(&db, &entries, 100, true).unwrap(), 3);
        assert_eq!(pending(&db).unwrap().len(), 3);
        let id = pending(&db).unwrap()[0].id.clone();
        remove_candidate(&db, &id).unwrap();
        assert_eq!(
            extract(&db, &[entry("f", "我不喜欢喝咖啡。")], 200, true).unwrap(),
            0
        );
    }

    #[test]
    fn disabled_extraction_stops_new_topic_candidates() {
        let db = super::super::open_in_memory_db().unwrap();
        {
            let mut conn = db.0.lock().unwrap();
            initialize(&conn).unwrap();
            super::super::soul::store::migrate(&mut conn).unwrap();
            conn.execute("UPDATE memory_extraction_settings SET enabled=0", [])
                .unwrap();
        }
        let entries = vec![entry("a", "我打算整理仓库。"), entry("b", "我打算每周整理一次仓库。")];
        assert_eq!(
            extract_with_topics(&db, &entries[..1], 100, true, Some("Asia/Shanghai")).unwrap(),
            0
        );
        {
            let conn = db.0.lock().unwrap();
            assert!(super::super::soul::open_loops::pending(&conn).unwrap().candidates.is_empty());
        }
        {
            let mut conn = db.0.lock().unwrap();
            conn.execute("UPDATE memory_extraction_settings SET enabled=1", [])
                .unwrap();
        }
        assert_eq!(
            extract_with_topics(&db, &entries[1..], 200, true, Some("Asia/Shanghai")).unwrap(),
            1
        );
    }

    #[test]
    fn candidates_and_schedule_survive_reopening_the_database() {
        let path = std::env::temp_dir().join(format!(
            "piko-memory-{}.db",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let expected;
        {
            let db = MemoryDb(std::sync::Mutex::new(
                rusqlite::Connection::open(&path).unwrap(),
            ));
            extract(&db, &[entry("a", "我喜欢早上喝咖啡")], 100, true).unwrap();
            expected = pending(&db).unwrap()[0].id.clone();
        }
        {
            let db = MemoryDb(std::sync::Mutex::new(
                rusqlite::Connection::open(&path).unwrap(),
            ));
            assert_eq!(pending(&db).unwrap()[0].id, expected);
            assert_eq!(status(&db).unwrap().last_run_at, 100);
            assert_eq!(
                extract(&db, &[entry("a", "我喜欢早上喝咖啡")], 2000, true).unwrap(),
                0
            );
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn failed_transaction_does_not_lose_source_or_candidates_and_can_retry() {
        let db = super::super::open_in_memory_db().unwrap();
        status(&db).unwrap();
        {
            let conn = db.0.lock().unwrap();
            conn.execute_batch(
                "CREATE TRIGGER extraction_failure BEFORE INSERT ON memory_extraction_processed
                BEGIN SELECT RAISE(ABORT, 'test failure'); END;",
            )
            .unwrap();
        }
        let entries = vec![entry("a", "我喜欢早上喝咖啡")];
        assert!(extract(&db, &entries, 100, true).is_err());
        assert_eq!(status(&db).unwrap().processed_count, 0);
        assert_eq!(status(&db).unwrap().last_run_at, 0);
        assert!(pending(&db).unwrap().is_empty());
        db.0.lock()
            .unwrap()
            .execute_batch("DROP TRIGGER extraction_failure;")
            .unwrap();
        assert_eq!(extract(&db, &entries, 101, true).unwrap(), 1);
    }

    #[test]
    fn confirmed_candidate_is_available_to_future_chat_context() {
        let db = super::super::open_in_memory_db().unwrap();
        extract(&db, &[entry("a", "我喜欢早上喝咖啡")], 100, true).unwrap();
        assert!(db
            .build_context(super::super::BuildContextInput {
                current_query: Some("咖啡".into()),
                window_type: None,
                limit: Some(10),
            })
            .unwrap()
            .is_empty());
        let mut candidates = pending(&db).unwrap();
        let input = super::super::ApplyCandidateInput {
            candidate_id: candidates[0].id.clone(),
            confirmed: Some(true),
        };
        let item = super::super::writer::apply_candidate(&db, &input, &mut candidates)
            .unwrap()
            .unwrap();
        remove_candidate(&db, &input.candidate_id).unwrap();
        let context = db
            .build_context(super::super::BuildContextInput {
                current_query: Some("咖啡".into()),
                window_type: None,
                limit: Some(10),
            })
            .unwrap();
        assert!(context.iter().any(|memory| memory.id == item.id));
        assert!(pending(&db).unwrap().is_empty());
    }
}
