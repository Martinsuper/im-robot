use super::model::{
    AddRelationInput, ApplyCandidateInput, BuildContextInput, CaptureCandidateInput,
    CreateMemoryInput, FeedbackInput, ListMemoriesInput, MemoryCandidate, MemoryExport,
    MemoryImportInput, MemoryItem, MemoryStatus, MemoryType, MergeMemoriesInput, ReflectionSummary,
    SearchMemoriesInput, SearchRelatedInput, UpdateMemoryInput,
};
use super::policy;
use super::reflection::{
    abstract_to_semantic, merge_memories, run_daily_reflection, run_weekly_reflection,
};
use super::store::MemoryDb;
use super::writer::{apply_candidate, extract_candidates, CandidateCache};
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
pub fn get_memory_detail(db: State<'_, MemoryDb>, id: String) -> Result<MemoryItem, String> {
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
        privacy_level: super::model::PrivacyLevel::PublicToUser,
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

#[tauri::command]
pub fn add_memory_relation(db: State<'_, MemoryDb>, input: AddRelationInput) -> Result<(), String> {
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

// === Phase 3+: Writer Commands ===

#[tauri::command]
pub fn capture_memory_candidates(
    cache: State<'_, CandidateCache>,
    input: CaptureCandidateInput,
) -> Result<Vec<MemoryCandidate>, String> {
    let candidates = extract_candidates(&input);
    let mut cached = cache.lock()?;
    cached.extend(candidates.clone());
    Ok(candidates)
}

#[tauri::command]
pub fn get_pending_candidates(
    cache: State<'_, CandidateCache>,
) -> Result<Vec<MemoryCandidate>, String> {
    let cached = cache.lock()?;
    Ok(cached
        .iter()
        .filter(|c| c.requires_confirmation)
        .cloned()
        .collect())
}

#[tauri::command]
pub fn apply_memory_candidates(
    app: AppHandle,
    db: State<'_, MemoryDb>,
    cache: State<'_, CandidateCache>,
    input: ApplyCandidateInput,
) -> Result<Option<MemoryItem>, String> {
    let item = {
        let mut locked = cache.lock()?;
        apply_candidate(&db, &input, &mut locked)?
    };
    if item.is_some() {
        let _ = app.emit_to("panel", "memories-updated", ());
    }
    Ok(item)
}

#[tauri::command]
pub fn reject_memory_candidate(
    cache: State<'_, CandidateCache>,
    candidate_id: String,
) -> Result<(), String> {
    let mut cached = cache.lock()?;
    cached.retain(|c| c.id != candidate_id);
    Ok(())
}

// === Phase 3+: Reflection Commands ===

#[tauri::command]
pub fn reflect_memory_now(
    app: AppHandle,
    db: State<'_, MemoryDb>,
    reflection_type: Option<String>,
) -> Result<ReflectionSummary, String> {
    let summary = match reflection_type.as_deref() {
        Some("weekly") => run_weekly_reflection(&db)?,
        _ => run_daily_reflection(&db)?,
    };
    let _ = app.emit("memory-reflected", &summary);
    Ok(summary)
}

#[tauri::command]
pub fn get_memory_summaries(
    db: State<'_, MemoryDb>,
    summary_type: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<ReflectionSummary>, String> {
    db.get_summaries(summary_type.as_deref(), limit.unwrap_or(10))
}

#[tauri::command]
pub fn merge_memories_cmd(
    app: AppHandle,
    db: State<'_, MemoryDb>,
    input: MergeMemoriesInput,
) -> Result<MemoryItem, String> {
    let item = merge_memories(&db, &input.keep_id, &input.remove_id)?;
    let _ = app.emit_to("panel", "memories-updated", ());
    Ok(item)
}

#[tauri::command]
pub fn get_merge_candidates(
    db: State<'_, MemoryDb>,
) -> Result<Vec<(MemoryItem, MemoryItem)>, String> {
    let recent = db.get_recent(100)?;
    let refs: Vec<&MemoryItem> = recent.iter().collect();

    let mut results = Vec::new();
    for i in 0..refs.len() {
        for j in (i + 1)..refs.len() {
            let a = refs[i];
            let b = refs[j];

            if a.memory_type != b.memory_type
                || a.status != MemoryStatus::Active
                || b.status != MemoryStatus::Active
            {
                continue;
            }

            // Check title similarity
            if titles_similar(&a.title, &b.title) {
                results.push((a.clone(), b.clone()));
            }
        }
    }

    Ok(results)
}

fn titles_similar(a: &str, b: &str) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let a_lower = a.to_lowercase();
    let b_lower = b.to_lowercase();
    if a_lower == b_lower {
        return true;
    }
    if (a_lower.contains(&b_lower) && b_lower.len() * 2 > a_lower.len())
        || (b_lower.contains(&a_lower) && a_lower.len() * 2 > b_lower.len())
    {
        return true;
    }
    let a_chars: Vec<char> = a_lower.chars().filter(|c| !c.is_whitespace()).collect();
    let b_chars: Vec<char> = b_lower.chars().filter(|c| !c.is_whitespace()).collect();
    if a_chars.len() < 3 || b_chars.len() < 3 {
        return false;
    }
    let mut shared = 0;
    for c in &a_chars {
        if b_chars.contains(c) {
            shared += 1;
        }
    }
    let min_len = a_chars.len().min(b_chars.len());
    (shared as f32 / min_len as f32) > 0.7
}

#[tauri::command]
pub fn abstract_semantic_from_events(
    app: AppHandle,
    db: State<'_, MemoryDb>,
    memory_type: Option<MemoryType>,
    min_count: Option<usize>,
) -> Result<Option<MemoryItem>, String> {
    let recent = db.get_recent(100)?;
    let filtered: Vec<&MemoryItem> = recent
        .iter()
        .filter(|m| {
            m.status == MemoryStatus::Active
                && (memory_type.is_none() || m.memory_type == memory_type.as_ref().unwrap().clone())
                && !m.tags.is_empty()
        })
        .collect();

    // Group by common tags
    use std::collections::HashMap;
    let mut tag_groups: HashMap<String, Vec<&MemoryItem>> = HashMap::new();
    for m in &filtered {
        for tag in &m.tags {
            tag_groups.entry(tag.clone()).or_default().push(m);
        }
    }

    let min = min_count.unwrap_or(3);
    for (_tag, group) in tag_groups {
        if group.len() >= min {
            if let Some(item) = abstract_to_semantic(&db, &group)? {
                let _ = app.emit_to("panel", "memories-updated", ());
                return Ok(Some(item));
            }
        }
    }

    Ok(None)
}

// === Phase 3+: Expiration & Maintenance ===

#[tauri::command]
pub fn expire_old_memories(app: AppHandle, db: State<'_, MemoryDb>) -> Result<usize, String> {
    let count = db.expire_old_memories()?;
    if count > 0 {
        let _ = app.emit_to("panel", "memories-updated", ());
    }
    Ok(count)
}

#[tauri::command]
pub fn recalculate_confidence(db: State<'_, MemoryDb>) -> Result<usize, String> {
    db.recalculate_confidence()
}

// === Import/Export ===

#[tauri::command]
pub fn export_memories(db: State<'_, MemoryDb>) -> Result<MemoryExport, String> {
    let (memories, relations) = db.export_all()?;
    Ok(MemoryExport {
        version: "1.0".to_string(),
        exported_at: now_unix(),
        memories,
        relations,
    })
}

#[tauri::command]
pub fn memory_preview_import(
    db: State<'_, MemoryDb>,
    input: MemoryImportInput,
) -> Result<super::model::ImportPreview, String> {
    let total = input.data.memories.len();
    let mut new = 0;
    let mut duplicates = 0;
    let mut previews = Vec::new();

    for item in &input.data.memories {
        let existing = db.get(&item.id);
        match existing {
            Ok(None) => {
                new += 1;
                previews.push(item.clone());
            }
            Ok(Some(_)) => {
                duplicates += 1;
            }
            Err(_) => {
                // Assume new if can't check
                new += 1;
                previews.push(item.clone());
            }
        }
    }

    Ok(super::model::ImportPreview {
        total,
        new,
        duplicates,
        previews: previews.into_iter().take(10).collect(),
    })
}

#[tauri::command]
pub fn import_memories(
    app: AppHandle,
    db: State<'_, MemoryDb>,
    input: MemoryImportInput,
) -> Result<usize, String> {
    let count = db.import_memories(&input.data.memories, &input.data.relations, &input.mode)?;
    let _ = app.emit_to("panel", "memories-updated", ());
    Ok(count)
}
