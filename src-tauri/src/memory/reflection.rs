use std::time::{SystemTime, UNIX_EPOCH};

use super::model::{
    MemoryItem, MemorySource, MemoryStatus, MemoryType, ReflectionSummary,
};
use super::store::MemoryDb;

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn summary_id() -> String {
    format!(
        "summary-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

// === Daily Reflection ===

/// Summarize today's interactions and generate insights.
pub fn run_daily_reflection(db: &MemoryDb) -> Result<ReflectionSummary, String> {
    let now = now_unix();
    let day_start = (now / 86400) * 86400;
    let day_end = day_start + 86400;

    // Get today's active memories
    let today_memories = db.get_in_range(day_start, day_end)?;

    // Group by type
    let profile_count = today_memories.iter().filter(|m| matches!(m.memory_type, MemoryType::Profile)).count();
    let event_count = today_memories.iter().filter(|m| matches!(m.memory_type, MemoryType::Event)).count();
    let operational_count = today_memories.iter().filter(|m| matches!(m.memory_type, MemoryType::Operational)).count();

    // Find most-used memory type today
    let dominant_type = if event_count >= profile_count && event_count >= operational_count {
        "事件记忆"
    } else if profile_count >= event_count && profile_count >= operational_count {
        "用户偏好"
    } else {
        "操作经验"
    };

    // Generate summary content
    let content = format!(
        "今日记忆总结：共记住 {} 条新记忆（{} 条偏好，{} 条事件，{} 条操作）。\n主导类型：{}。",
        today_memories.len(),
        profile_count,
        event_count,
        operational_count,
        dominant_type,
    );

    let summary = ReflectionSummary {
        id: summary_id(),
        summary_type: "daily".to_string(),
        content,
        created_at: now,
        period_start: Some(day_start),
        period_end: Some(day_end),
    };

    // Persist summary
    db.save_summary(&summary)?;

    Ok(summary)
}

// === Weekly Reflection ===

/// Deep weekly reflection: abstract semantic memories, detect patterns, merge duplicates.
pub fn run_weekly_reflection(db: &MemoryDb) -> Result<ReflectionSummary, String> {
    let now = now_unix();
    let week_start = now - 7 * 86400;

    // Get recent memories from the past week
    let recent = db.get_recent(100)?;
    let week_memories: Vec<&MemoryItem> = recent
        .iter()
        .filter(|m| m.created_at >= week_start && m.status == MemoryStatus::Active)
        .collect();

    // Detect similar event memories that could be merged into semantic memories
    let merge_suggestions = detect_merge_candidates(&week_memories);

    // Detect patterns for semantic abstraction
    let patterns = detect_patterns(&week_memories);

    // Generate summary
    let mut content = format!(
        "本周反思：共分析 {} 条活跃记忆。\n",
        week_memories.len()
    );

    if !merge_suggestions.is_empty() {
        content.push_str(&format!(
            "\n发现 {} 组可合并的记忆：\n",
            merge_suggestions.len()
        ));
        for (i, (a, b)) in merge_suggestions.iter().take(5).enumerate() {
            content.push_str(&format!("  {}. [{}] 和 [{}] 可能重复\n", i + 1, a.title, b.title));
        }
    }

    if !patterns.is_empty() {
        content.push_str(&format!(
            "\n发现 {} 个模式，建议生成语义记忆：\n",
            patterns.len()
        ));
        for (i, pattern) in patterns.iter().take(5).enumerate() {
            content.push_str(&format!("  {}. {}\n", i + 1, pattern));
        }
    }

    let summary = ReflectionSummary {
        id: summary_id(),
        summary_type: "weekly".to_string(),
        content,
        created_at: now,
        period_start: Some(week_start),
        period_end: Some(now),
    };

    db.save_summary(&summary)?;

    Ok(summary)
}

// === Memory Deduplication ===

/// Find pairs of memories that are similar enough to be merged.
fn detect_merge_candidates<'a>(memories: &[&'a MemoryItem]) -> Vec<(&'a MemoryItem, &'a MemoryItem)> {
    let mut candidates = Vec::new();

    for i in 0..memories.len() {
        for j in (i + 1)..memories.len() {
            let a = &memories[i];
            let b = &memories[j];

            // Only consider same-type active memories
            if a.memory_type != b.memory_type
                || a.status != MemoryStatus::Active
                || b.status != MemoryStatus::Active
            {
                continue;
            }

            // Check title similarity using simple heuristics
            if titles_similar(&a.title, &b.title) {
                candidates.push((*a, *b));
            }
        }
    }

    candidates
}

/// Check if two titles are similar enough to be duplicates.
fn titles_similar(a: &str, b: &str) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }

    let a_lower = a.to_lowercase();
    let b_lower = b.to_lowercase();

    // Exact match
    if a_lower == b_lower {
        return true;
    }

    // One contains the other (significant overlap)
    if (a_lower.contains(&b_lower) && b_lower.len() * 2 > a_lower.len())
        || (b_lower.contains(&a_lower) && a_lower.len() * 2 > b_lower.len())
    {
        return true;
    }

    // Shared word ratio (for Chinese, use character overlap)
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
    let ratio = shared as f32 / min_len as f32;

    ratio > 0.7
}

// === Pattern Detection ===

/// Detect repeated patterns that could be abstracted into semantic memories.
fn detect_patterns(memories: &[&MemoryItem]) -> Vec<String> {
    let mut patterns = Vec::new();

    // Count memory types
    let type_counts = count_by_type(memories);

    // If many events of the same topic, suggest a semantic memory
    for (memory_type, count) in &type_counts {
        if *count >= 3 {
            let type_label = match memory_type {
                MemoryType::Event => "事件",
                MemoryType::Operational => "操作",
                MemoryType::Profile => "偏好",
                _ => continue,
            };
            patterns.push(format!(
                "最近多次出现{}类记忆（{} 次），建议归纳为稳定的语义知识。",
                type_label, count
            ));
        }
    }

    // Check for recurring tags
    let tag_freq = count_tags(memories);
    for (tag, count) in tag_freq {
        if count >= 3 {
            patterns.push(format!("标签「{}」频繁出现（{} 次），可能是重要主题。", tag, count));
        }
    }

    patterns
}

fn count_by_type(memories: &[&MemoryItem]) -> Vec<(MemoryType, usize)> {
    use std::collections::HashMap;
    let mut counts: HashMap<MemoryType, usize> = HashMap::new();
    for m in memories {
        *counts.entry(m.memory_type.clone()).or_default() += 1;
    }
    counts.into_iter().collect()
}

fn count_tags(memories: &[&MemoryItem]) -> Vec<(String, usize)> {
    use std::collections::HashMap;
    let mut counts: HashMap<String, usize> = HashMap::new();
    for m in memories {
        for tag in &m.tags {
            *counts.entry(tag.clone()).or_default() += 1;
        }
    }
    let mut result: Vec<_> = counts.into_iter().collect();
    result.sort_by(|a, b| b.1.cmp(&a.1));
    result
}

// === Merge Memories ===

/// Merge two similar memories, keeping the more important one.
pub fn merge_memories(
    db: &MemoryDb,
    keep_id: &str,
    remove_id: &str,
) -> Result<MemoryItem, String> {
    let keep = db
        .get(keep_id)?
        .ok_or_else(|| "找不到要保留的记忆".to_string())?;
    let remove = db
        .get(remove_id)?
        .ok_or_else(|| "找不到要合并的记忆".to_string())?;

    // Merge content: append removed content as a note
    let new_content = format!(
        "{}\n\n（合并自：{}）",
        keep.content, remove.content
    );

    // Merge tags
    let mut merged_tags = keep.tags.clone();
    for tag in &remove.tags {
        if !merged_tags.contains(tag) {
            merged_tags.push(tag.clone());
        }
    }

    // Keep higher importance
    let new_importance = keep.importance.max(remove.importance);

    // Update keep memory
    let updated = db.update_with_full(
        keep_id,
        &new_content,
        new_importance,
        &merged_tags,
    )?;

    // Delete removed memory
    db.delete(remove_id)?;

    // Record relation
    db.add_relation(&super::model::AddRelationInput {
        from_id: keep_id.to_string(),
        to_id: remove_id.to_string(),
        relation_type: "supersedes".to_string(),
    })?;

    Ok(updated)
}

// === Auto-generate Semantic Memories ===

/// From repeated event patterns, generate a semantic memory.
pub fn abstract_to_semantic(db: &MemoryDb, events: &[&MemoryItem]) -> Result<Option<MemoryItem>, String> {
    if events.len() < 3 {
        return Ok(None);
    }

    // Find common tags
    let common_tags = find_common_tags(events);

    // Generate a semantic memory title and content
    let title = if !common_tags.is_empty() {
        format!("关于「{}」的常见模式", common_tags.join("、"))
    } else {
        "反复出现的行为模式".to_string()
    };

    let content = format!(
        "根据最近 {} 次相关事件总结：\n{}",
        events.len(),
        events
            .iter()
            .map(|e| format!("• {}", e.title))
            .collect::<Vec<_>>()
            .join("\n")
    );

    let now = now_unix();
    let item = MemoryItem {
        id: format!("semantic-{}", now * 1000 + std::process::id() as u64),
        memory_type: MemoryType::Semantic,
        title,
        content,
        source: MemorySource::SystemReflection,
        importance: 5,
        confidence: 0.6,
        recency_score: 1.0,
        privacy_level: MemoryItem::default_privacy(),
        status: MemoryStatus::Active,
        created_at: now,
        updated_at: now,
        last_used_at: None,
        expires_at: None,
        tags: common_tags,
        embedding_id: None,
        is_pinned: false,
    };

    db.create(&item)?;

    // Link source events to new semantic memory
    for event in events {
        let _ = db.add_relation(&super::model::AddRelationInput {
            from_id: item.id.clone(),
            to_id: event.id.clone(),
            relation_type: "derived_from".to_string(),
        });
    }

    Ok(Some(item))
}

fn find_common_tags(events: &[&MemoryItem]) -> Vec<String> {
    use std::collections::HashMap;
    let mut counts: HashMap<String, usize> = HashMap::new();
    for e in events {
        for tag in &e.tags {
            *counts.entry(tag.clone()).or_default() += 1;
        }
    }
    let min_count = (events.len() + 1) / 2; // appear in at least half
    let mut common: Vec<_> = counts
        .into_iter()
        .filter(|(_, c)| *c >= min_count)
        .map(|(tag, _)| tag)
        .collect();
    common.sort();
    common
}

impl MemoryItem {
    fn default_privacy() -> super::model::PrivacyLevel {
        super::model::PrivacyLevel::PublicToUser
    }
}
