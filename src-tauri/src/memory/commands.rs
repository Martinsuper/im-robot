use super::model::{
    CreateMemoryInput, ListMemoriesInput, MemoryItem, MemoryStatus, MemoryType, PrivacyLevel,
    UpdateMemoryInput,
};
use super::policy;
use super::store::MemoryDb;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

fn memory_id() -> String {
    format!(
        "memory-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[tauri::command]
pub fn list_memories(
    db: State<'_, MemoryDb>,
    input: Option<ListMemoriesInput>,
) -> Result<Vec<MemoryItem>, String> {
    let input = input.unwrap_or_default();
    db.list(input)
}

#[tauri::command]
pub fn get_memory_detail(
    db: State<'_, MemoryDb>,
    id: String,
) -> Result<MemoryItem, String> {
    db.get(&id)?.ok_or_else(|| "未找到该记忆".to_string())
}

#[tauri::command]
pub fn create_memory(
    app: AppHandle,
    db: State<'_, MemoryDb>,
    input: CreateMemoryInput,
) -> Result<MemoryItem, String> {
    policy::validate_create_input(&input)?;

    if policy::contains_sensitive_content(&input.content) {
        return Err("记忆内容包含敏感信息，已拦截".to_string());
    }

    let now = now_unix();
    let item = MemoryItem {
        id: memory_id(),
        memory_type: input.memory_type,
        title: input.title.trim().to_string(),
        content: input.content,
        source: input.source,
        importance: input.importance,
        confidence: 0.5,
        recency_score: 1.0,
        privacy_level: PrivacyLevel::PublicToUser,
        status: MemoryStatus::Active,
        created_at: now,
        updated_at: now,
        last_used_at: None,
        expires_at: None,
        tags: input.tags,
        embedding_id: None,
    };

    db.create(&item)?;
    let _ = app.emit_to("panel", "memories-updated", ());

    Ok(item)
}

#[tauri::command]
pub fn update_memory(
    app: AppHandle,
    db: State<'_, MemoryDb>,
    id: String,
    input: UpdateMemoryInput,
) -> Result<MemoryItem, String> {
    let item = db.update(&id, input)?;
    let _ = app.emit_to("panel", "memories-updated", ());
    Ok(item)
}

#[tauri::command]
pub fn delete_memory(app: AppHandle, db: State<'_, MemoryDb>, id: String) -> Result<(), String> {
    db.delete(&id)?;
    let _ = app.emit_to("panel", "memories-updated", ());
    Ok(())
}

#[tauri::command]
pub fn clear_memories(
    app: AppHandle,
    db: State<'_, MemoryDb>,
    memory_type: Option<MemoryType>,
) -> Result<usize, String> {
    let count = match memory_type {
        Some(t) => db.clear_type(t)?,
        None => db.clear_all()?,
    };
    let _ = app.emit_to("panel", "memories-updated", ());
    Ok(count)
}
