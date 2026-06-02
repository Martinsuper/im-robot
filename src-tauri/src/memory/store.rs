use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

use super::model::{
    ListMemoriesInput, MemoryItem, MemoryStatus, MemoryType, UpdateMemoryInput,
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
            embedding_id TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_items(memory_type);
        CREATE INDEX IF NOT EXISTS idx_memory_status ON memory_items(status);
        CREATE INDEX IF NOT EXISTS idx_memory_updated ON memory_items(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_memory_type_status ON memory_items(memory_type, status);

        CREATE TABLE IF NOT EXISTS memory_feedback (
            id TEXT PRIMARY KEY,
            memory_id TEXT NOT NULL,
            feedback_type TEXT NOT NULL,
            value INTEGER NOT NULL,
            comment TEXT,
            created_at INTEGER NOT NULL
        );
    "#,
    )
    .map_err(|e| format!("创建内存表失败: {}", e))
}

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
    })
}

impl MemoryDb {
    pub fn list(&self, input: ListMemoriesInput) -> Result<Vec<MemoryItem>, String> {
        let db = self
            .0
            .lock()
            .map_err(|_| "数据库锁获取失败".to_string())?;

        let results = match (input.memory_type, input.status) {
            (Some(mtype), Some(status)) => {
                let mut stmt = db
                    .prepare(
                        "SELECT id, memory_type, title, content, source, importance, \
                         confidence, recency_score, privacy_level, status, \
                         created_at, updated_at, last_used_at, expires_at, tags, embedding_id \
                         FROM memory_items \
                         WHERE memory_type = ?1 AND status = ?2 \
                         ORDER BY updated_at DESC LIMIT ?3",
                    )
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(
                        params![
                            serde_json::to_string(&mtype).map_err(|e| e.to_string())?,
                            serde_json::to_string(&status).map_err(|e| e.to_string())?,
                            input.limit.unwrap_or(100)
                        ],
                        row_to_memory_item,
                    )
                    .map_err(|e| e.to_string())?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?
            }
            (Some(mtype), None) => {
                let mut stmt = db
                    .prepare(
                        "SELECT id, memory_type, title, content, source, importance, \
                         confidence, recency_score, privacy_level, status, \
                         created_at, updated_at, last_used_at, expires_at, tags, embedding_id \
                         FROM memory_items \
                         WHERE memory_type = ?1 \
                         ORDER BY updated_at DESC LIMIT ?2",
                    )
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(
                        params![
                            serde_json::to_string(&mtype).map_err(|e| e.to_string())?,
                            input.limit.unwrap_or(100)
                        ],
                        row_to_memory_item,
                    )
                    .map_err(|e| e.to_string())?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?
            }
            (None, Some(status)) => {
                let mut stmt = db
                    .prepare(
                        "SELECT id, memory_type, title, content, source, importance, \
                         confidence, recency_score, privacy_level, status, \
                         created_at, updated_at, last_used_at, expires_at, tags, embedding_id \
                         FROM memory_items \
                         WHERE status = ?1 \
                         ORDER BY updated_at DESC LIMIT ?2",
                    )
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(
                        params![
                            serde_json::to_string(&status).map_err(|e| e.to_string())?,
                            input.limit.unwrap_or(100)
                        ],
                        row_to_memory_item,
                    )
                    .map_err(|e| e.to_string())?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?
            }
            (None, None) => {
                let mut stmt = db
                    .prepare(
                        "SELECT id, memory_type, title, content, source, importance, \
                         confidence, recency_score, privacy_level, status, \
                         created_at, updated_at, last_used_at, expires_at, tags, embedding_id \
                         FROM memory_items \
                         ORDER BY updated_at DESC LIMIT ?1",
                    )
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(
                        params![input.limit.unwrap_or(100)],
                        row_to_memory_item,
                    )
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
            .prepare(
                "SELECT id, memory_type, title, content, source, importance, \
                 confidence, recency_score, privacy_level, status, \
                 created_at, updated_at, last_used_at, expires_at, tags, embedding_id \
                 FROM memory_items WHERE id = ?1",
            )
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

        let tags_json =
            serde_json::to_string(&item.tags).map_err(|e| e.to_string())?;
        let memory_type_str =
            serde_json::to_string(&item.memory_type).map_err(|e| e.to_string())?;
        let source_str =
            serde_json::to_string(&item.source).map_err(|e| e.to_string())?;
        let privacy_str =
            serde_json::to_string(&item.privacy_level).map_err(|e| e.to_string())?;
        let status_str =
            serde_json::to_string(&item.status).map_err(|e| e.to_string())?;

        db.execute(
            "INSERT INTO memory_items \
             (id, memory_type, title, content, source, importance, \
              confidence, recency_score, privacy_level, status, \
              created_at, updated_at, last_used_at, expires_at, tags, embedding_id) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
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

        // First get existing item
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
        let tags_json =
            serde_json::to_string(&new_tags).map_err(|e| e.to_string())?;

        db.execute(
            "UPDATE memory_items \
             SET title = ?1, content = ?2, importance = ?3, \
                 tags = ?4, updated_at = ?5 \
             WHERE id = ?6",
            params![new_title, new_content, new_importance, tags_json, now, id],
        )
        .map_err(|e| e.to_string())?;

        // Return updated item
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
        let deleted_str = serde_json::to_string(&MemoryStatus::Deleted)
            .map_err(|e| e.to_string())?;

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
        let deleted_str = serde_json::to_string(&MemoryStatus::Deleted)
            .map_err(|e| e.to_string())?;
        let type_str = serde_json::to_string(&memory_type)
            .map_err(|e| e.to_string())?;

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
        let deleted_str = serde_json::to_string(&MemoryStatus::Deleted)
            .map_err(|e| e.to_string())?;

        db.execute(
            "UPDATE memory_items SET status = ?1, updated_at = ?2 WHERE status != 'Deleted'",
            params![deleted_str, now],
        )
        .map_err(|e| e.to_string())
    }
}
