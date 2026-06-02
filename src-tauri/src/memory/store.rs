use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

use super::model::{
    AddRelationInput, BuildContextInput, FeedbackInput, ListMemoriesInput, MemoryItem,
    MemoryRelation, MemoryStatus, MemoryType, SearchMemoriesInput, SearchRelatedInput,
    UpdateMemoryInput,
};

pub struct MemoryDb(pub Mutex<Connection>);

pub fn memory_db_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("memory.db"))
}

pub fn init_memory_db(app: &tauri::AppHandle) -> Result<MemoryDb, String> {
    let path =
        memory_db_path(app).ok_or_else(|| "无法获取应用配置目录".to_string())?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建配置目录: {}", e))?;
    }

    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )
    .map_err(|e| format!("无法打开内存数据库: {}", e))?;

    conn.execute_batch(
        "
        PRAGMA journal_mode=WAL;
        PRAGMA busy_timeout=5000;
    ",
    )
    .map_err(|e| format!("设置数据库参数失败: {}", e))?;

    run_migrations(&conn)?;

    Ok(MemoryDb(Mutex::new(conn)))
}

fn run_migrations(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS memory_items (
            id TEXT PRIMARY KEY,
            memory_type TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            source TEXT NOT NULL,
            importance INTEGER NOT NULL DEFAULT 1,
            confidence REAL NOT NULL DEFAULT 0.5,
            recency_score REAL NOT NULL DEFAULT 0.5,
            privacy_level TEXT NOT NULL DEFAULT 'PublicToUser',
            status TEXT NOT NULL DEFAULT 'Active',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_used_at INTEGER,
            expires_at INTEGER,
            tags TEXT NOT NULL DEFAULT '[]',
            embedding_id TEXT,
            is_pinned INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_items(memory_type);
        CREATE INDEX IF NOT EXISTS idx_memory_status ON memory_items(status);
        CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory_items(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_memory_type_status ON memory_items(memory_type, status);
        CREATE INDEX IF NOT EXISTS idx_memory_pinned ON memory_items(is_pinned, updated_at DESC);

        -- FTS5 full-text search index (Phase 2)
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
            title, content, tags,
            content='memory_items',
            content_rowid='rowid',
            tokenize='trigram'
        );

        -- Sync triggers for FTS5
        CREATE TRIGGER IF NOT EXISTS memory_items_ai AFTER INSERT ON memory_items BEGIN
            INSERT INTO memory_fts(rowid, title, content, tags)
            VALUES (new.rowid, new.title, new.content, new.tags);
        END;

        CREATE TRIGGER IF NOT EXISTS memory_items_ad AFTER DELETE ON memory_items BEGIN
            INSERT INTO memory_fts(memory_fts, rowid, title, content, tags)
            VALUES ('delete', old.rowid, old.title, old.content, old.tags);
        END;

        CREATE TRIGGER IF NOT EXISTS memory_items_au AFTER UPDATE ON memory_items BEGIN
            INSERT INTO memory_fts(memory_fts, rowid, title, content, tags)
            VALUES ('delete', old.rowid, old.title, old.content, old.tags);
            INSERT INTO memory_fts(rowid, title, content, tags)
            VALUES (new.rowid, new.title, new.content, new.tags);
        END;

        CREATE TABLE IF NOT EXISTS memory_relations (
            from_id TEXT NOT NULL,
            to_id TEXT NOT NULL,
            relation_type TEXT NOT NULL,
            PRIMARY KEY (from_id, to_id, relation_type)
        );

        CREATE INDEX IF NOT EXISTS idx_relations_from ON memory_relations(from_id);
        CREATE INDEX IF NOT EXISTS idx_relations_to ON memory_relations(to_id);

        CREATE TABLE IF NOT EXISTS memory_feedback (
            id TEXT PRIMARY KEY,
            memory_id TEXT NOT NULL,
            feedback_type TEXT NOT NULL,
            value INTEGER NOT NULL,
            comment TEXT,
            created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_feedback_memory ON memory_feedback(memory_id);

        CREATE TABLE IF NOT EXISTS memory_summaries (
            id TEXT PRIMARY KEY,
            summary_type TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            period_start INTEGER,
            period_end INTEGER
        );
    "#,
    )
    .map_err(|e| format!("创建内存表失败: {}", e))
}

/// Read a MemoryItem from a row with 17 columns (including is_pinned).
fn row_to_memory_item(row: &rusqlite::Row<'_>) -> Result<MemoryItem, rusqlite::Error> {
    let tags_json: String = row.get(14)?;
    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
    Ok(MemoryItem {
        id: row.get(0)?,
        memory_type: row.get(1)?,
        title: row.get(2)?,
        content: row.get(3)?,
        source: row.get(4)?,
        importance: row.get(5)?,
        confidence: row.get(6)?,
        recency_score: row.get(7)?,
        privacy_level: row.get(8)?,
        status: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        last_used_at: row.get(12)?,
        expires_at: row.get(13)?,
        tags,
        embedding_id: row.get(15)?,
        is_pinned: row.get::<_, i32>(16).map(|v| v != 0).unwrap_or(false),
    })
}

const SELECT_COLS: &str = "SELECT id, memory_type, title, content, source, importance, \
    confidence, recency_score, privacy_level, status, \
    created_at, updated_at, last_used_at, expires_at, tags, embedding_id, is_pinned";

/// Recency decay factor: score drops ~50% after 30 days.
fn recency_decay_factor(updated_at: u64, now: u64) -> f32 {
    let days = ((now.saturating_sub(updated_at)) as f32) / 86400.0;
    1.0 / (1.0 + 0.02 * days)
}

impl MemoryDb {
    // === Phase 1 CRUD ===

    pub fn list(&self, input: ListMemoriesInput) -> Result<Vec<MemoryItem>, String> {
        let db = self
            .0
            .lock()
            .map_err(|_| "数据库锁获取失败".to_string())?;

        let limit = input.limit.unwrap_or(100);
        let results = match (input.memory_type, input.status) {
            (Some(mtype), Some(status)) => {
                let mtype_str = serde_json::to_string(&mtype).map_err(|e| e.to_string())?;
                let status_str = serde_json::to_string(&status).map_err(|e| e.to_string())?;
                let mut stmt = db
                    .prepare(&format!(
                        "{SELECT_COLS} FROM memory_items \
                         WHERE memory_type = ?1 AND status = ?2 \
                         ORDER BY is_pinned DESC, updated_at DESC LIMIT ?3"
                    ))
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(params![mtype_str, status_str, limit], row_to_memory_item)
                    .map_err(|e| e.to_string())?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?
            }
            (Some(mtype), None) => {
                let mtype_str = serde_json::to_string(&mtype).map_err(|e| e.to_string())?;
                let mut stmt = db
                    .prepare(&format!(
                        "{SELECT_COLS} FROM memory_items \
                         WHERE memory_type = ?1 \
                         ORDER BY is_pinned DESC, updated_at DESC LIMIT ?2"
                    ))
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(params![mtype_str, limit], row_to_memory_item)
                    .map_err(|e| e.to_string())?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?
            }
            (None, Some(status)) => {
                let status_str = serde_json::to_string(&status).map_err(|e| e.to_string())?;
                let mut stmt = db
                    .prepare(&format!(
                        "{SELECT_COLS} FROM memory_items \
                         WHERE status = ?1 \
                         ORDER BY is_pinned DESC, updated_at DESC LIMIT ?2"
                    ))
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(params![status_str, limit], row_to_memory_item)
                    .map_err(|e| e.to_string())?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?
            }
            (None, None) => {
                let mut stmt = db
                    .prepare(&format!(
                        "{SELECT_COLS} FROM memory_items \
                         ORDER BY is_pinned DESC, updated_at DESC LIMIT ?1"
                    ))
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(params![limit], row_to_memory_item)
                    .map_err(|e| e.to_string())?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?
            }
        };

        Ok(results)
    }

    pub fn get(&self, id: &str) -> Result<Option<MemoryItem>, String> {
        let db = self
            .0
            .lock()
            .map_err(|_| "数据库锁获取失败".to_string())?;

        let mut stmt = db
            .prepare(&format!("{SELECT_COLS} FROM memory_items WHERE id = ?1"))
            .map_err(|e| e.to_string())?;

        let result = stmt
            .query_row(params![id], row_to_memory_item)
            .optional()
            .map_err(|e| e.to_string())?;

        Ok(result)
    }

    pub fn create(&self, item: &MemoryItem) -> Result<(), String> {
        let db = self
            .0
            .lock()
            .map_err(|_| "数据库锁获取失败".to_string())?;

        let tags_json = serde_json::to_string(&item.tags).map_err(|e| e.to_string())?;
        let memory_type_str =
            serde_json::to_string(&item.memory_type).map_err(|e| e.to_string())?;
        let source_str = serde_json::to_string(&item.source).map_err(|e| e.to_string())?;
        let privacy_str = serde_json::to_string(&item.privacy_level).map_err(|e| e.to_string())?;
        let status_str = serde_json::to_string(&item.status).map_err(|e| e.to_string())?;

        db.execute(
            "INSERT INTO memory_items \
             (id, memory_type, title, content, source, importance, \
              confidence, recency_score, privacy_level, status, \
              created_at, updated_at, last_used_at, expires_at, tags, embedding_id, is_pinned) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                item.id,
                memory_type_str,
                item.title,
                item.content,
                source_str,
                item.importance,
                item.confidence,
                item.recency_score,
                privacy_str,
                status_str,
                item.created_at,
                item.updated_at,
                item.last_used_at,
                item.expires_at,
                tags_json,
                item.embedding_id,
                if item.is_pinned { 1 } else { 0 },
            ],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn update(&self, id: &str, input: UpdateMemoryInput) -> Result<MemoryItem, String> {
        let db = self
            .0
            .lock()
            .map_err(|_| "数据库锁获取失败".to_string())?;

        let existing = self
            .get(id)?
            .ok_or_else(|| "未找到该记忆".to_string())?;

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let new_title = input.title.as_deref().unwrap_or(&existing.title);
        let new_content = input.content.as_deref().unwrap_or(&existing.content);
        let new_importance = input.importance.unwrap_or(existing.importance);
        let new_tags = input.tags.as_ref().unwrap_or(&existing.tags);
        let tags_json = serde_json::to_string(&new_tags).map_err(|e| e.to_string())?;

        db.execute(
            "UPDATE memory_items \
             SET title = ?1, content = ?2, importance = ?3, \
                 tags = ?4, updated_at = ?5 \
             WHERE id = ?6",
            params![new_title, new_content, new_importance, tags_json, now, id],
        )
        .map_err(|e| e.to_string())?;

        Ok(MemoryItem {
            title: new_title.to_string(),
            content: new_content.to_string(),
            importance: new_importance,
            tags: new_tags.clone(),
            updated_at: now,
            ..existing
        })
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let db = self
            .0
            .lock()
            .map_err(|_| "数据库锁获取失败".to_string())?;

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let deleted_str = serde_json::to_string(&MemoryStatus::Deleted).map_err(|e| e.to_string())?;

        db.execute(
            "UPDATE memory_items SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![deleted_str, now, id],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn clear_type(&self, memory_type: MemoryType) -> Result<usize, String> {
        let db = self
            .0
            .lock()
            .map_err(|_| "数据库锁获取失败".to_string())?;

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let deleted_str = serde_json::to_string(&MemoryStatus::Deleted).map_err(|e| e.to_string())?;
        let type_str = serde_json::to_string(&memory_type).map_err(|e| e.to_string())?;

        db.execute(
            "UPDATE memory_items SET status = ?1, updated_at = ?2 WHERE memory_type = ?3 AND status != 'Deleted'",
            params![deleted_str, now, type_str],
        )
        .map_err(|e| e.to_string())
    }

    pub fn clear_all(&self) -> Result<usize, String> {
        let db = self
            .0
            .lock()
            .map_err(|_| "数据库锁获取失败".to_string())?;

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let deleted_str = serde_json::to_string(&MemoryStatus::Deleted).map_err(|e| e.to_string())?;

        db.execute(
            "UPDATE memory_items SET status = ?1, updated_at = ?2 WHERE status != 'Deleted'",
            params![deleted_str, now],
        )
        .map_err(|e| e.to_string())
    }

    // === Phase 2: Search ===

    pub fn search(&self, input: SearchMemoriesInput) -> Result<Vec<MemoryItem>, String> {
        let db = self
            .0
            .lock()
            .map_err(|_| "数据库锁获取失败".to_string())?;

        let limit = input.limit.unwrap_or(20);

        // Use FTS5 for full-text search if the query is non-empty
        if !input.query.is_empty() {
            let query = input.query.replace('\'', "''"); // escape single quotes
            let base_query = format!(
                "{SELECT_COLS} FROM memory_items \
                 WHERE rowid IN (SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?1) \
                 AND status = 'Active'"
            );

            let (sql, _param_count) = match &input.memory_type {
                Some(mtype) => {
                    let _type_str = serde_json::to_string(mtype).map_err(|e| e.to_string())?;
                    (format!("{} AND memory_type = ?2 ORDER BY rank, updated_at DESC LIMIT ?3", base_query), 3)
                }
                None => (format!("{} ORDER BY rank, updated_at DESC LIMIT ?2", base_query), 2),
            };

            let mut stmt = db.prepare(&sql).map_err(|e| e.to_string())?;
            let rows = match &input.memory_type {
                Some(_) => {
                    let type_str = serde_json::to_string(&input.memory_type).map_err(|e| e.to_string())?;
                    stmt.query_map(params![format!("'{}'", query), type_str, limit], row_to_memory_item)
                }
                None => stmt.query_map(params![format!("'{}'", query), limit], row_to_memory_item),
            }
            .map_err(|e| e.to_string())?;

            let results = rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;

            // If FTS5 returns no results, fall back to LIKE search
            if !results.is_empty() {
                return Ok(results);
            }
        }

        // Fallback: LIKE search
        let like_pattern = format!("%{}%", input.query);
        let mut stmt = db
            .prepare(&format!(
                "{SELECT_COLS} FROM memory_items \
                 WHERE (title LIKE ?1 OR content LIKE ?1) AND status = 'Active'\
                 {} \
                 ORDER BY is_pinned DESC, updated_at DESC LIMIT ?{}",
                if input.memory_type.is_some() {
                    " AND memory_type = ?2"
                } else {
                    ""
                },
                if input.memory_type.is_some() { "3" } else { "2" }
            ))
            .map_err(|e| e.to_string())?;

        let rows = match &input.memory_type {
            Some(mtype) => {
                let type_str = serde_json::to_string(mtype).map_err(|e| e.to_string())?;
                stmt.query_map(
                    params![like_pattern, type_str, limit],
                    row_to_memory_item,
                )
            }
            None => stmt.query_map(params![like_pattern, limit], row_to_memory_item),
        }
        .map_err(|e| e.to_string())?;

        Ok(rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?)
    }

    pub fn search_related(&self, input: SearchRelatedInput) -> Result<Vec<MemoryItem>, String> {
        let db = self
            .0
            .lock()
            .map_err(|_| "数据库锁获取失败".to_string())?;

        let limit = input.limit.unwrap_or(10);
        let query = input.query.replace('\'', "''");

        // Search via FTS5, then sort by relevance (confidence * recency * importance)
        let mut stmt = db
            .prepare(&format!(
                "{SELECT_COLS} FROM memory_items \
                 WHERE rowid IN (SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?1) \
                 AND status = 'Active' \
                 ORDER BY is_pinned DESC, (confidence * recency_score * importance) DESC \
                 LIMIT ?2"
            ))
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(
                params![format!("'{}'", query), limit],
                row_to_memory_item,
            )
            .map_err(|e| e.to_string())?;

        let results = rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        if !results.is_empty() {
            return Ok(results);
        }

        // Fallback: LIKE search with recency weighting
        let like_pattern = format!("%{}%", input.query);
        let mut stmt = db
            .prepare(&format!(
                "{SELECT_COLS} FROM memory_items \
                 WHERE (title LIKE ?1 OR content LIKE ?1) AND status = 'Active' \
                 ORDER BY is_pinned DESC, (confidence * recency_score * importance) DESC \
                 LIMIT ?2"
            ))
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![like_pattern, limit], row_to_memory_item)
            .map_err(|e| e.to_string())?;

        Ok(rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?)
    }

    pub fn get_recent(&self, limit: usize) -> Result<Vec<MemoryItem>, String> {
        let db = self
            .0
            .lock()
            .map_err(|_| "数据库锁获取失败".to_string())?;

        let mut stmt = db
            .prepare(&format!(
                "{SELECT_COLS} FROM memory_items \
                 WHERE status = 'Active' \
                 ORDER BY is_pinned DESC, updated_at DESC LIMIT ?1"
            ))
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![limit], row_to_memory_item)
            .map_err(|e| e.to_string())?;

        Ok(rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?)
    }

    pub fn build_context(&self, input: BuildContextInput) -> Result<Vec<MemoryItem>, String> {
        let db = self
            .0
            .lock()
            .map_err(|_| "数据库锁获取失败".to_string())?;

        let limit = input.limit.unwrap_or(15);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // Priority order:
        // 1. Pinned memories first
        // 2. Profile memories (user preferences)
        // 3. Memories matching query (via FTS5)
        // 4. Recent memories sorted by recency score
        let query = input.current_query.as_deref().unwrap_or("");
        let escaped_query = query.replace('\'', "''");

        // Build context using a composite scoring query
        let mut stmt = db
            .prepare(&format!(
                "{SELECT_COLS} FROM memory_items \
                 WHERE status = 'Active' \
                 AND privacy_level = '\"PublicToUser\"' \
                 ORDER BY \
                    is_pinned DESC, \
                    CASE WHEN memory_type = '\"Profile\"' THEN 1 ELSE 0 END DESC, \
                    CASE WHEN rowid IN (SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?1) THEN 1 ELSE 0 END DESC, \
                    (confidence * recency_score * importance) DESC \
                 LIMIT ?2"
            ))
            .map_err(|e| e.to_string())?;

        let fts_query = if !escaped_query.is_empty() {
            format!("'{}'", escaped_query)
        } else {
            // Match all if no query provided
            "*".to_string()
        };

        let rows = stmt
            .query_map(params![fts_query, limit], row_to_memory_item)
            .map_err(|e| e.to_string())?;

        let mut results = rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        // Update recency scores
        for item in &mut results {
            item.recency_score = recency_decay_factor(item.updated_at, now);
            // Update last_used_at
            let _ = db.execute(
                "UPDATE memory_items SET last_used_at = ?1, recency_score = ?2 WHERE id = ?3",
                params![now, item.recency_score, item.id],
            );
        }

        Ok(results)
    }

    // === Phase 2: Pin / Unpin ===

    pub fn pin(&self, id: &str) -> Result<(), String> {
        let db = self
            .0
            .lock()
            .map_err(|_| "数据库锁获取失败".to_string())?;

        db.execute(
            "UPDATE memory_items SET is_pinned = 1, updated_at = ?1 WHERE id = ?2",
            params![
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
                id
            ],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn unpin(&self, id: &str) -> Result<(), String> {
        let db = self
            .0
            .lock()
            .map_err(|_| "数据库锁获取失败".to_string())?;

        db.execute(
            "UPDATE memory_items SET is_pinned = 0, updated_at = ?1 WHERE id = ?2",
            params![
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
                id
            ],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    // === Phase 2: Feedback ===

    pub fn add_feedback(&self, input: &FeedbackInput) -> Result<(), String> {
        let db = self
            .0
            .lock()
            .map_err(|_| "数据库锁获取失败".to_string())?;

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let feedback_id = format!("feedback-{}", now * 1000 + std::process::id() as u64);

        db.execute(
            "INSERT INTO memory_feedback (id, memory_id, feedback_type, value, comment, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                feedback_id,
                input.memory_id,
                input.feedback_type,
                input.value,
                input.comment,
                now,
            ],
        )
        .map_err(|e| e.to_string())?;

        // Adjust memory confidence based on feedback
        let confidence_delta = match input.feedback_type.as_str() {
            "correct" => 0.05,
            "incorrect" => -0.1,
            "useful" => 0.03,
            "useless" => -0.05,
            _ => 0.0,
        };

        if confidence_delta != 0.0 {
            db.execute(
                "UPDATE memory_items SET confidence = MIN(1.0, MAX(0.0, confidence + ?1)), \
                 updated_at = ?2 WHERE id = ?3",
                params![
                    confidence_delta,
                    now,
                    input.memory_id,
                ],
            )
            .map_err(|e| e.to_string())?;
        }

        Ok(())
    }

    // === Phase 2: Memory Relations ===

    pub fn add_relation(&self, input: &AddRelationInput) -> Result<(), String> {
        let db = self
            .0
            .lock()
            .map_err(|_| "数据库锁获取失败".to_string())?;

        db.execute(
            "INSERT OR IGNORE INTO memory_relations (from_id, to_id, relation_type) \
             VALUES (?1, ?2, ?3)",
            params![input.from_id, input.to_id, input.relation_type],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn remove_relation(&self, from_id: &str, to_id: &str, relation_type: &str) -> Result<(), String> {
        let db = self
            .0
            .lock()
            .map_err(|_| "数据库锁获取失败".to_string())?;

        db.execute(
            "DELETE FROM memory_relations WHERE from_id = ?1 AND to_id = ?2 AND relation_type = ?3",
            params![from_id, to_id, relation_type],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn get_relations(&self, memory_id: &str) -> Result<Vec<MemoryRelation>, String> {
        let db = self
            .0
            .lock()
            .map_err(|_| "数据库锁获取失败".to_string())?;

        let mut stmt = db
            .prepare(
                "SELECT from_id, to_id, relation_type FROM memory_relations \
                 WHERE from_id = ?1 OR to_id = ?1",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![memory_id], |row| {
                Ok(MemoryRelation {
                    from_id: row.get(0)?,
                    to_id: row.get(1)?,
                    relation_type: row.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;

        Ok(rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?)
    }
}
