//! Durable, local conversation extraction. Model answers are never treated as facts.
use super::{MemoryCandidate, MemoryDb};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
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
        "CREATE TABLE IF NOT EXISTS memory_provenance (memory_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, captured_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS memory_extraction_settings (
        id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 1,
        interval_minutes INTEGER NOT NULL DEFAULT 30, last_run_at INTEGER NOT NULL DEFAULT 0);
        INSERT OR IGNORE INTO memory_extraction_settings(id) VALUES(1);
        CREATE TABLE IF NOT EXISTS memory_extraction_processed (entry_id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS memory_extraction_candidates (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS memory_extraction_seen (fingerprint TEXT PRIMARY KEY);
 CREATE TABLE IF NOT EXISTS memory_extraction_semantic (
 entry_id TEXT PRIMARY KEY, prompt_hash TEXT NOT NULL);",
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
            let explicit =
                sentence.trim().starts_with("请记住") || sentence.trim().starts_with("记住");
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
                || (!explicit && statement.contains(['?', '？']))
                || (!explicit && !markers.iter().any(|marker| lower.starts_with(marker)))
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
fn extract(
    db: &MemoryDb,
    entries: &[crate::chat_session::ChatHistoryEntry],
    now: u64,
    force: bool,
) -> Result<usize, String> {
    extract_with_topics(db, entries, now, force, None)
}

fn extract_with_topics(
    db: &MemoryDb,
    entries: &[crate::chat_session::ChatHistoryEntry],
    now: u64,
    force: bool,
    topic_timezone: Option<&str>,
) -> Result<usize, String> {
    extract_with_candidates(db, entries, now, force, topic_timezone, None, false)
}

fn extract_with_candidates(
    db: &MemoryDb,
    entries: &[crate::chat_session::ChatHistoryEntry],
    now: u64,
    force: bool,
    topic_timezone: Option<&str>,
    candidates: Option<&HashMap<String, Vec<MemoryCandidate>>>,
    rescan: bool,
) -> Result<usize, String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    initialize(&conn)?;
    // A failed/unsupported soul migration must not disable ordinary extraction.
    let topic_timezone =
        topic_timezone.filter(|_| super::soul::store::ensure_available(&conn).is_ok());
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
        if source_deleted(&tx, &entry.id)? {
            continue;
        }
        let exists = tx
            .query_row(
                "SELECT 1 FROM memory_extraction_processed WHERE entry_id=?1",
                [&entry.id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .is_some();
        if exists && !rescan && candidates.is_none() {
            continue;
        }
        // Only user statements; assistant claims of successful actions are unverified.
        for (index, mut candidate) in candidates
            .and_then(|items| items.get(&entry.id).cloned())
            .unwrap_or_else(|| conversation_candidates(&entry.prompt))
            .into_iter()
            .enumerate()
        {
            candidate.id = if candidates.is_some() {
                format!(
                    "semantic-{}-{:x}",
                    entry.id,
                    Sha256::digest(candidate.content.as_bytes())
                )
            } else {
                format!("auto-{}-{}", entry.id, index)
            };
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
            tx.execute("INSERT OR REPLACE INTO memory_provenance(memory_id,source_id,captured_at) VALUES(?1,?2,?3)", params![format!("memory-{}", candidate.id), entry.id, now]).map_err(|e|e.to_string())?;
            count += 1;
        }
        // Manual memory extraction may bypass its timer, but must never bypass
        // the user's disabled setting for generating new open-topic candidates.
        if enabled {
            if let Some(timezone) = topic_timezone {
                let topic_now =
                    i64::try_from(now).map_err(|_| crate::error_codes::INVALID_EXTRACTION_TIME)?;
                count += super::soul::open_loops::enqueue(&tx, entry, topic_now, timezone)?;
            }
        }
        tx.execute(
            "INSERT OR IGNORE INTO memory_extraction_processed(entry_id) VALUES(?1)",
            [&entry.id],
        )
        .map_err(|e| e.to_string())?;
        if candidates.is_some() {
            tx.execute(
                "INSERT INTO memory_extraction_semantic(entry_id,prompt_hash) VALUES(?1,?2)
                 ON CONFLICT(entry_id) DO UPDATE SET prompt_hash=excluded.prompt_hash",
                params![entry.id, prompt_hash(&entry.prompt)],
            )
            .map_err(|e| e.to_string())?;
        }
        processed += 1;
        if processed >= super::tuning::EXTRACTION_BATCH_LIMIT {
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

pub(super) fn source_deleted(conn: &rusqlite::Connection, id: &str) -> Result<bool, String> {
    let available: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='soul_source_tombstones')",
        [], |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    if !available {
        return Ok(false);
    }
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM soul_source_tombstones WHERE source_id=?1)",
        [id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

fn prompt_hash(prompt: &str) -> String {
    format!("v1:{:x}", Sha256::digest(prompt.as_bytes()))
}

fn semantic_backlog(
    db: &MemoryDb,
    entries: &[crate::chat_session::ChatHistoryEntry],
    force: bool,
) -> Result<Vec<crate::chat_session::ChatHistoryEntry>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    initialize(&conn)?;
    let mut pending = Vec::new();
    for entry in entries {
        if source_deleted(&conn, &entry.id)? {
            continue;
        }
        let previous: Option<String> = conn
            .query_row(
                "SELECT prompt_hash FROM memory_extraction_semantic WHERE entry_id=?1",
                [&entry.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if force || previous.as_deref() != Some(&prompt_hash(&entry.prompt)) {
            pending.push(entry.clone());
        }
    }
    Ok(pending)
}

// Both the worker and manual command use this gate; no database lock crosses an await.
static EXTRACTION_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn run(app: &AppHandle, force: bool) -> Result<usize, String> {
    let _guard = EXTRACTION_GATE.lock().await;
    let sessions = crate::chat_session::repository::load_chat_sessions(app, true)?;
    let entries = crate::chat_session::entries_view(&sessions);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let db = Arc::clone(app.state::<Arc<MemoryDb>>().inner());
    let current = {
        let db = Arc::clone(&db);
        crate::common::on_blocking(move || status(&db)).await?
    };
    if !force
        && (!current.enabled
            || (current.last_run_at != 0
                && now.saturating_sub(current.last_run_at) < current.interval_minutes * 60))
    {
        return Ok(0);
    }
    let timezone = app
        .try_state::<super::soul::model::SoulBootStatus>()
        .filter(|state| state.0)
        .and_then(|_| iana_time_zone::get_timezone().ok());
    let settings = crate::settings::read_settings(app);
    let mut count = 0;
    if crate::providers::validate_ai_settings(&settings.ai).is_ok() {
        let pending = {
            let db = Arc::clone(&db);
            let entries = entries.clone();
            crate::common::on_blocking(move || semantic_backlog(&db, &entries, force)).await?
        };
        // Manual extraction reviews all history; the worker drains one bounded batch per tick.
        for batch in
            pending
                .chunks(super::semantic::BATCH_SIZE)
                .take(if force { usize::MAX } else { 1 })
        {
            let candidates = super::semantic::generate(&settings.ai, batch).await?;
            let enabled = {
                let db = Arc::clone(&db);
                crate::common::on_blocking(move || Ok(status(&db)?.enabled)).await?
            };
            if !force && !enabled {
                return Ok(count);
            }
            let latest = crate::chat_session::entries_view(
                &crate::chat_session::repository::load_chat_sessions(app, true)?,
            );
            let live: Vec<_> = batch
                .iter()
                .filter(|entry| {
                    latest
                        .iter()
                        .any(|current| current.id == entry.id && current.prompt == entry.prompt)
                })
                .cloned()
                .collect();
            let added = {
                let db = Arc::clone(&db);
                let timezone = timezone.clone();
                crate::common::on_blocking(move || {
                    extract_with_candidates(
                        &db,
                        &live,
                        now,
                        true,
                        timezone.as_deref(),
                        Some(&candidates),
                        true,
                    )
                })
                .await?
            };
            count += added;
            emit_extraction(app, added);
        }
        if !force && pending.len() > super::semantic::BATCH_SIZE {
            let db = Arc::clone(&db);
            crate::common::on_blocking(move || {
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                conn.execute(
                    "UPDATE memory_extraction_settings SET last_run_at=0 WHERE id=1",
                    [],
                )
                .map_err(|e| e.to_string())?;
                Ok(())
            })
            .await?;
        }
    } else {
        let db = Arc::clone(&db);
        let timezone = timezone.clone();
        count = crate::common::on_blocking(move || {
            let mut count = 0;
            if force {
                for batch in entries.chunks(100) {
                    count += extract_with_candidates(
                        &db,
                        batch,
                        now,
                        true,
                        timezone.as_deref(),
                        None,
                        true,
                    )?;
                }
            } else {
                count = extract_with_topics(&db, &entries, now, false, timezone.as_deref())?;
            }
            Ok(count)
        })
        .await?;
        emit_extraction(app, count);
    }
    Ok(count)
}

fn emit_extraction(app: &AppHandle, count: usize) {
    if count > 0 {
        let _ = app.emit(
            "memory-captured",
            crate::runtime_types::MemoryCapturedEvent {
                confirmed: 0,
                pending: count,
            },
        );
    }
    let _ = app.emit("memories-updated", ());
}

pub fn start(app: AppHandle) {
    // One worker serializes all automatic passes; missed intervals catch up on startup.
    crate::background::SUPERVISOR.spawn_async("memory-extraction", move |worker| async move {
        while !worker.cancelled() {
            let extraction = run(&app, false).await;
            let maintenance = {
                let db = app.state::<Arc<MemoryDb>>();
                super::maintenance::maintain(&db, false)
            };
            let _ = app.emit("memories-updated", ());
            match (extraction, maintenance) {
                (Ok(_), Ok(_)) => worker.health(Ok(())),
                result => worker.health(Err(format!("memory_knowledge_upkeep_failed: {result:?}"))),
            }
            if !worker.sleep(std::time::Duration::from_secs(60)).await {
                break;
            }
        }
        Ok(())
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
    run(&app, true).await
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
    fn interval_disable_sensitive_storage_and_batch_limit() {
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
            1
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
        let entries = [
            entry("a", "我打算整理仓库。"),
            entry("b", "我打算每周整理一次仓库。"),
        ];
        assert_eq!(
            extract_with_topics(&db, &entries[..1], 100, true, Some("Asia/Shanghai")).unwrap(),
            0
        );
        {
            let conn = db.0.lock().unwrap();
            assert!(super::super::soul::open_loops::pending(&conn)
                .unwrap()
                .candidates
                .is_empty());
        }
        {
            let conn = db.0.lock().unwrap();
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
            let db = MemoryDb(crate::data_gate::DataMutex::new(
                rusqlite::Connection::open(&path).unwrap(),
            ));
            extract(&db, &[entry("a", "我喜欢早上喝咖啡")], 100, true).unwrap();
            expected = pending(&db).unwrap()[0].id.clone();
        }
        {
            let db = MemoryDb(crate::data_gate::DataMutex::new(
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
    #[test]
    fn semantic_extraction_revisits_legacy_history_and_tracks_success_atomically() {
        let db = super::super::open_in_memory_db().unwrap();
        let entries = [entry("legacy", "源码放在 /projects/piko")];
        // The old rule scanner found nothing and marked this source as processed.
        assert_eq!(extract(&db, &entries, 100, true).unwrap(), 0);
        assert_eq!(semantic_backlog(&db, &entries, false).unwrap().len(), 1);
        let mut fact = conversation_candidates("我喜欢喝茶").remove(0);
        fact.content = entries[0].prompt.clone();
        fact.memory_type = super::super::MemoryType::Semantic;
        let candidates = HashMap::from([(entries[0].id.clone(), vec![fact])]);
        {
            let conn = db.0.lock().unwrap();
            conn.execute_batch(
                "CREATE TRIGGER semantic_failure BEFORE INSERT ON memory_extraction_semantic
                BEGIN SELECT RAISE(ABORT,'injected failure'); END;",
            )
            .unwrap();
        }
        assert!(
            extract_with_candidates(&db, &entries, 200, true, None, Some(&candidates), true)
                .is_err()
        );
        assert!(pending(&db).unwrap().is_empty());
        assert_eq!(semantic_backlog(&db, &entries, false).unwrap().len(), 1);
        db.0.lock()
            .unwrap()
            .execute_batch("DROP TRIGGER semantic_failure;")
            .unwrap();
        assert_eq!(
            extract_with_candidates(&db, &entries, 201, true, None, Some(&candidates), true)
                .unwrap(),
            1
        );
        assert!(semantic_backlog(&db, &entries, false).unwrap().is_empty());
        // An explicit rescan includes old history but cannot resurrect rejected candidates.
        assert_eq!(semantic_backlog(&db, &entries, true).unwrap().len(), 1);
        remove_candidate(&db, &pending(&db).unwrap()[0].id).unwrap();
        assert_eq!(
            extract_with_candidates(&db, &entries, 300, true, None, Some(&candidates), true)
                .unwrap(),
            0
        );
        let edited = [entry("legacy", "源码放在 /projects/updated")];
        assert_eq!(semantic_backlog(&db, &edited, false).unwrap().len(), 1);
    }

    #[test]
    fn explicit_sensitive_memory_can_be_extracted_confirmed_and_recalled() {
        let db = super::super::open_in_memory_db().unwrap();
        let entries = [entry(
            "config",
            "请记住：服务配置 apiKey=example-test-key，地址 https://example.test/v1?mode=test",
        )];
        assert_eq!(extract(&db, &entries, 100, true).unwrap(), 1);
        let mut candidates = pending(&db).unwrap();
        assert!(candidates[0].content.contains("apiKey=example-test-key"));
        let input = super::super::ApplyCandidateInput {
            candidate_id: candidates[0].id.clone(),
            confirmed: Some(true),
        };
        let saved = super::super::writer::apply_candidate(&db, &input, &mut candidates)
            .unwrap()
            .unwrap();
        remove_candidate(&db, &input.candidate_id).unwrap();
        let context = db
            .build_context(super::super::BuildContextInput {
                current_query: Some("apiKey".into()),
                window_type: None,
                limit: Some(10),
            })
            .unwrap();
        assert!(context
            .iter()
            .any(|item| item.id == saved.id && item.content.contains("example-test-key")));
    }
    #[test]
    fn rescans_do_not_restore_deleted_sources() {
        let db = super::super::open_in_memory_db().unwrap();
        let entries = [entry("deleted", "请记住服务配置 apiKey=example-test-key")];
        {
            let mut conn = db.0.lock().unwrap();
            super::super::soul::store::migrate(&mut conn).unwrap();
            super::super::soul::lifecycle::delete_sources(&mut conn, &["deleted".into()], 100)
                .unwrap();
        }
        assert!(semantic_backlog(&db, &entries, true).unwrap().is_empty());
        assert_eq!(
            extract_with_candidates(&db, &entries, 200, true, None, None, true).unwrap(),
            0
        );
        assert!(pending(&db).unwrap().is_empty());
    }
}
