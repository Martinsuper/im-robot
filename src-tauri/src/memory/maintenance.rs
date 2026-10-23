//! Local, bounded upkeep of knowledge accumulated from user conversation evidence.
use super::store::sql_literal::{STATUS_ACTIVE, TYPE_OPERATIONAL, TYPE_SEMANTIC};
use super::{model::*, store::MemoryDb};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

const DAY: u64 = 86400;
pub(super) static GATE: Mutex<()> = Mutex::new(());

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MaintenanceReport {
    pub collected: usize,
    pub duplicates: usize,
    pub archived: usize,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceStatus {
    pub auto_store: bool,
    pub last_run_at: u64,
    pub next_run_at: u64,
    pub knowledge_count: u64,
    pub pending_count: u64,
    pub report: MaintenanceReport,
}
fn initialize(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS knowledge_maintenance (
        id INTEGER PRIMARY KEY CHECK(id=1), auto_store INTEGER NOT NULL DEFAULT 1,
        last_run_at INTEGER NOT NULL DEFAULT 0, report TEXT NOT NULL DEFAULT '{}');
        INSERT OR IGNORE INTO knowledge_maintenance(id) VALUES(1);",
    )
    .map_err(|e| e.to_string())
}
fn now() -> u64 {
    crate::common::unix_timestamp()
}

pub fn status(db: &MemoryDb) -> Result<MaintenanceStatus, String> {
    // Initialize extraction tables before joining the durable candidate queue.
    let extraction = super::extraction::status(db)?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    initialize(&conn)?;
    let (auto_store, last_run_at, report): (bool, u64, String) = conn
        .query_row(
            "SELECT auto_store,last_run_at,report FROM knowledge_maintenance WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|e| e.to_string())?;
    let count = conn
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM memory_items WHERE status={STATUS_ACTIVE}
        AND memory_type IN ({TYPE_SEMANTIC},{TYPE_OPERATIONAL})
        AND (expires_at IS NULL OR expires_at>?1)"
            ),
            [now()],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(MaintenanceStatus {
        auto_store,
        last_run_at,
        next_run_at: if extraction.enabled {
            if last_run_at == 0 {
                now()
            } else {
                last_run_at + DAY
            }
        } else {
            0
        },
        knowledge_count: count,
        pending_count: extraction.pending_count,
        report: serde_json::from_str(&report).map_err(|e| e.to_string())?,
    })
}
fn eligible(candidate: &MemoryCandidate) -> bool {
    let text = format!("{} {}", candidate.title, candidate.content).to_lowercase();
    candidate.confidence >= super::tuning::MAINTENANCE_MIN_CONFIDENCE
        && matches!(
            candidate.memory_type,
            MemoryType::Semantic | MemoryType::Profile
        )
        && matches!(candidate.source, MemorySource::Conversation)
        && !super::policy::contains_sensitive_content(&text)
        && !super::tuning::MAINTENANCE_BLOCKLIST
            .iter()
            .any(|word| text.contains(word))
}

enum Collection {
    Stored,
    Duplicate,
    Skipped,
}

// Re-read eligibility, source tombstones and conflicts under the same transaction
// that writes the memory and consumes its candidate. Deleted/rejected sources cannot
// be revived by a stale background pass, and crash recovery cannot lose a candidate.
fn collect_candidate(db: &MemoryDb, candidate_id: &str) -> Result<Collection, String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let payload: Option<String> = tx
        .query_row(
            "SELECT payload FROM memory_extraction_candidates WHERE id=?1",
            [candidate_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(payload) = payload else {
        return Ok(Collection::Skipped);
    };
    let candidate: MemoryCandidate = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
    if !eligible(&candidate) {
        return Ok(Collection::Skipped);
    }
    let id = format!("memory-{}", candidate.id);
    let source: Option<String> = tx
        .query_row(
            "SELECT source_id FROM memory_provenance WHERE memory_id=?1",
            [&id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if source.is_none()
        || super::extraction::source_deleted(&tx, source.as_deref().unwrap_or_default())?
    {
        return Ok(Collection::Skipped);
    }
    let existing: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM memory_items WHERE id=?1)",
            [&id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let duplicate: bool = tx.query_row(&format!("SELECT EXISTS(SELECT 1 FROM memory_items WHERE status={STATUS_ACTIVE} AND content=?1 AND id<>?2)"), params![candidate.content,id], |r|r.get(0)).map_err(|e|e.to_string())?;
    let conflict: bool = tx.query_row(&format!("SELECT EXISTS(SELECT 1 FROM memory_items WHERE status={STATUS_ACTIVE} AND title=?1 AND content<>?2)"), params![candidate.title,candidate.content], |r|r.get(0)).map_err(|e|e.to_string())?;
    if conflict && !existing {
        return Ok(Collection::Skipped);
    }
    let outcome = if existing {
        Collection::Skipped
    } else if duplicate {
        Collection::Duplicate
    } else {
        MemoryDb::insert_into(&tx, &super::writer::candidate_memory(candidate))?;
        Collection::Stored
    };
    tx.execute(
        "DELETE FROM memory_extraction_candidates WHERE id=?1",
        [candidate_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(outcome)
}

pub fn maintain(db: &MemoryDb, force: bool) -> Result<MaintenanceReport, String> {
    let _gate = GATE.lock().map_err(|e| e.to_string())?;
    let state = status(db)?;
    if !force
        && (!super::extraction::status(db)?.enabled
            || (state.last_run_at != 0 && now().saturating_sub(state.last_run_at) < DAY))
    {
        return Ok(state.report);
    }
    let mut report = MaintenanceReport::default();
    if state.auto_store {
        for candidate in super::extraction::pending(db)?.into_iter() {
            if !eligible(&candidate) {
                continue;
            }
            match collect_candidate(db, &candidate.id)? {
                Collection::Stored => report.collected += 1,
                Collection::Duplicate => report.duplicates += 1,
                Collection::Skipped => {}
            }
            if report.collected + report.duplicates >= super::tuning::MAINTENANCE_COLLECT_CAP {
                break;
            }
        }
    }
    report.archived = db.expire_old_memories()?;
    db.recalculate_confidence()?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE knowledge_maintenance SET last_run_at=?1,report=?2 WHERE id=1",
        params![
            now(),
            serde_json::to_string(&report).map_err(|e| e.to_string())?
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(report)
}
#[tauri::command]
pub fn knowledge_get_maintenance_status(
    db: State<'_, Arc<MemoryDb>>,
) -> Result<MaintenanceStatus, String> {
    status(&db)
}
#[tauri::command]
pub fn knowledge_configure_maintenance(
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
    auto_store: bool,
) -> Result<MaintenanceStatus, String> {
    let _gate = GATE.lock().map_err(|e| e.to_string())?;
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        initialize(&conn)?;
        conn.execute(
            "UPDATE knowledge_maintenance SET auto_store=?1 WHERE id=1",
            [auto_store],
        )
        .map_err(|e| e.to_string())?;
    }
    let _ = app.emit("memories-updated", ());
    status(&db)
}
#[tauri::command]
pub fn knowledge_maintain(
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
) -> Result<MaintenanceReport, String> {
    let report = maintain(&db, true)?;
    let _ = app.emit("memories-updated", ());
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn candidate(id: &str, title: &str, content: &str) -> MemoryCandidate {
        MemoryCandidate {
            id: id.into(),
            title: title.into(),
            content: content.into(),
            memory_type: MemoryType::Semantic,
            source: MemorySource::Conversation,
            confidence: 0.8,
            importance: 5,
            tags: vec!["自动提取".into()],
            requires_confirmation: true,
        }
    }
    fn queue(db: &MemoryDb, candidate: &MemoryCandidate) {
        super::super::extraction::status(db).unwrap();
        let conn = db.0.lock().unwrap();
        conn.execute(
            "INSERT INTO memory_extraction_candidates VALUES(?1,?2)",
            params![candidate.id, serde_json::to_string(candidate).unwrap()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memory_provenance VALUES(?1,?2,?3)",
            params![
                format!("memory-{}", candidate.id),
                format!("source-{}", candidate.id),
                now()
            ],
        )
        .unwrap();
    }
    #[test]
    fn daily_upkeep_collects_grounded_knowledge_and_is_idempotent() {
        let db = super::super::open_in_memory_db().unwrap();
        queue(
            &db,
            &candidate("a", "项目测试", "这个项目用 cargo test 运行测试"),
        );
        let first = maintain(&db, false).unwrap();
        assert_eq!(first.collected, 1);
        assert!(super::super::extraction::pending(&db).unwrap().is_empty());
        assert_eq!(status(&db).unwrap().knowledge_count, 1);
        {
            let conn = db.0.lock().unwrap();
            conn.execute(
                "UPDATE memory_items SET updated_at=100 WHERE id='memory-a'",
                [],
            )
            .unwrap();
        }
        let before = db.get("memory-a").unwrap().unwrap();
        assert!(before.expires_at.is_none());
        maintain(&db, true).unwrap();
        let after = db.get("memory-a").unwrap().unwrap();
        assert_eq!(before.updated_at, after.updated_at);
        assert!(after.recency_score < 1.0);
        assert_eq!(status(&db).unwrap().knowledge_count, 1);
        assert!(status(&db).unwrap().next_run_at > now());
    }
    #[test]
    fn sensitive_conflicting_uncertain_and_deleted_sources_stay_out() {
        let db = super::super::open_in_memory_db().unwrap();
        queue(
            &db,
            &candidate("a", "项目测试", "这个项目用 cargo test 运行测试"),
        );
        maintain(&db, true).unwrap();
        queue(
            &db,
            &candidate("b", "项目测试", "这个项目使用另一种测试方式"),
        );
        queue(&db, &candidate("c", "密钥", "我的 API_KEY 是 secret"));
        queue(&db, &candidate("d", "更正", "部署路径改为新的目录"));
        let mut uncertain = candidate("e", "猜测", "也许使用 Python");
        uncertain.confidence = 0.5;
        queue(&db, &uncertain);
        queue(&db, &candidate("f", "已删来源", "这个项目使用 SQLite"));
        {
            let conn = db.0.lock().unwrap();
            conn.execute_batch("CREATE TABLE IF NOT EXISTS soul_source_tombstones(source_id TEXT PRIMARY KEY); INSERT INTO soul_source_tombstones(source_id) VALUES('source-f');").unwrap();
        }
        assert_eq!(maintain(&db, true).unwrap().collected, 0);
        assert_eq!(super::super::extraction::pending(&db).unwrap().len(), 5);
        assert_eq!(status(&db).unwrap().knowledge_count, 1);
    }
    #[test]
    fn disabled_collection_is_respected_and_exact_duplicates_are_skipped() {
        let db = super::super::open_in_memory_db().unwrap();
        queue(&db, &candidate("a", "项目测试", "这个项目使用 Rust"));
        status(&db).unwrap();
        {
            let conn = db.0.lock().unwrap();
            conn.execute("UPDATE knowledge_maintenance SET auto_store=0", [])
                .unwrap();
        }
        assert_eq!(maintain(&db, true).unwrap().collected, 0);
        assert_eq!(super::super::extraction::pending(&db).unwrap().len(), 1);
        {
            let conn = db.0.lock().unwrap();
            conn.execute("UPDATE knowledge_maintenance SET auto_store=1", [])
                .unwrap();
        }
        assert_eq!(maintain(&db, true).unwrap().collected, 1);
        queue(&db, &candidate("b", "另一标题", "这个项目使用 Rust"));
        assert_eq!(maintain(&db, true).unwrap().duplicates, 1);
        assert_eq!(status(&db).unwrap().knowledge_count, 1);
        queue(
            &db,
            &candidate("c", "另一个项目", "另一个项目使用 TypeScript"),
        );
        {
            let conn = db.0.lock().unwrap();
            conn.execute("UPDATE memory_extraction_settings SET enabled=0", [])
                .unwrap();
            conn.execute("UPDATE knowledge_maintenance SET last_run_at=0", [])
                .unwrap();
        }
        assert_eq!(maintain(&db, false).unwrap().collected, 0);
        assert_eq!(status(&db).unwrap().next_run_at, 0);
        assert!(db.get("memory-c").unwrap().is_none());
    }
    #[test]
    fn upkeep_archives_expired_records_without_deleting_or_archiving_pins() {
        let db = super::super::open_in_memory_db().unwrap();
        queue(&db, &candidate("a", "部署方法", "这个项目部署到本地服务器"));
        maintain(&db, true).unwrap();
        {
            let conn = db.0.lock().unwrap();
            conn.execute(
                "UPDATE memory_items SET expires_at=1,is_pinned=1 WHERE id='memory-a'",
                [],
            )
            .unwrap();
        }
        assert_eq!(maintain(&db, true).unwrap().archived, 0);
        assert!(db.get("memory-a").unwrap().unwrap().expires_at.is_none());
        assert!(matches!(
            db.get("memory-a").unwrap().unwrap().status,
            MemoryStatus::Active
        ));
        {
            let conn = db.0.lock().unwrap();
            conn.execute(
                "UPDATE memory_items SET is_pinned=0, expires_at=1 WHERE id='memory-a'",
                [],
            )
            .unwrap();
        }
        assert_eq!(maintain(&db, true).unwrap().archived, 1);
        assert!(matches!(
            db.get("memory-a").unwrap().unwrap().status,
            MemoryStatus::Archived
        ));
    }
    #[test]
    fn collection_rechecks_removed_candidates_and_rolls_back_failed_consumption() {
        let db = super::super::open_in_memory_db().unwrap();
        queue(&db, &candidate("a", "项目测试", "这个项目使用 Rust"));
        super::super::extraction::remove_candidate(&db, "a").unwrap();
        assert!(matches!(
            collect_candidate(&db, "a").unwrap(),
            Collection::Skipped
        ));
        assert!(db.get("memory-a").unwrap().is_none());
        queue(&db, &candidate("b", "测试运行", "使用 cargo test 运行"));
        {
            let conn = db.0.lock().unwrap();
            conn.execute_batch("CREATE TRIGGER reject_candidate_delete BEFORE DELETE ON memory_extraction_candidates BEGIN SELECT RAISE(ABORT,'simulated failure'); END;").unwrap();
        }
        assert!(collect_candidate(&db, "b").is_err());
        assert!(db.get("memory-b").unwrap().is_none());
        assert_eq!(super::super::extraction::pending(&db).unwrap().len(), 1);
        {
            let conn = db.0.lock().unwrap();
            conn.execute_batch("DROP TRIGGER reject_candidate_delete;")
                .unwrap();
        }
        assert!(matches!(
            collect_candidate(&db, "b").unwrap(),
            Collection::Stored
        ));
        assert!(super::super::extraction::pending(&db).unwrap().is_empty());
    }
}
