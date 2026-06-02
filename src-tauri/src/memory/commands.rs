use super::model::{
    AddRelationInput, BuildContextInput, CreateMemoryInput, FeedbackInput, ListMemoriesInput,
    MemoryItem, MemoryStatus, MemoryType, PrivacyLevel, SearchMemoriesInput, SearchRelatedInput,
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

// === Phase 1 Commands ===

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
        is_pinned: false,
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

// === Phase 2: Search & Retrieval ===

#[tauri::command]
pub fn search_memories(
    db: State<'_, MemoryDb>,
    input: SearchMemoriesInput,
) -> Result<Vec<MemoryItem>, String> {
    db.search(input)
}

#[tauri::command]
pub fn search_related_memories(
    db: State<'_, MemoryDb>,
    input: SearchRelatedInput,
) -> Result<Vec<MemoryItem>, String> {
    db.search_related(input)
}

#[tauri::command]
pub fn get_recent_memories(
    db: State<'_, MemoryDb>,
    limit: Option<usize>,
) -> Result<Vec<MemoryItem>, String> {
    db.get_recent(limit.unwrap_or(10))
}

#[tauri::command]
pub fn build_memory_context(
    db: State<'_, MemoryDb>,
    input: BuildContextInput,
) -> Result<Vec<MemoryItem>, String> {
    db.build_context(input)
}

// === Phase 2: Pin / Unpin ===

#[tauri::command]
pub fn pin_memory(app: AppHandle, db: State<'_, MemoryDb>, id: String) -> Result<(), String> {
    db.pin(&id)?;
    let _ = app.emit_to("panel", "memories-updated", ());
    Ok(())
}

#[tauri::command]
pub fn unpin_memory(app: AppHandle, db: State<'_, MemoryDb>, id: String) -> Result<(), String> {
    db.unpin(&id)?;
    let _ = app.emit_to("panel", "memories-updated", ());
    Ok(())
}

// === Phase 2: Feedback ===

#[tauri::command]
pub fn feedback_memory(
    app: AppHandle,
    db: State<'_, MemoryDb>,
    input: FeedbackInput,
) -> Result<(), String> {
    db.add_feedback(&input)?;
    let _ = app.emit_to("panel", "memories-updated", ());
    Ok(())
}

// === Phase 2: Relations ===

#[tauri::command]
pub fn add_memory_relation(
    db: State<'_, MemoryDb>,
    input: AddRelationInput,
) -> Result<(), String> {
    db.add_relation(&input)
}

#[tauri::command]
pub fn remove_memory_relation(
    db: State<'_, MemoryDb>,
    from_id: String,
    to_id: String,
    relation_type: String,
) -> Result<(), String> {
    db.remove_relation(&from_id, &to_id, &relation_type)
}

#[tauri::command]
pub fn get_memory_relations(
    db: State<'_, MemoryDb>,
    memory_id: String,
) -> Result<Vec<super::model::MemoryRelation>, String> {
    db.get_relations(&memory_id)
}
