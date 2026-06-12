use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use super::model::{
    ApplyCandidateInput, CaptureCandidateInput, MemoryCandidate, MemoryItem, MemorySource,
    MemoryStatus, MemoryType, PrivacyLevel,
};
use super::store::MemoryDb;

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn candidate_id() -> String {
    format!(
        "cand-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn char_window_around(value: &str, marker: &str, before: usize, after: usize) -> Option<String> {
    let marker_byte_pos = value.find(marker)?;
    let marker_char_pos = value[..marker_byte_pos].chars().count();
    let marker_len = marker.chars().count();
    let start = marker_char_pos.saturating_sub(before);
    let len = before + marker_len + after;
    Some(value.chars().skip(start).take(len).collect::<String>())
}

/// In-memory cache of pending candidates (not yet persisted).
pub struct CandidateCache(Mutex<Vec<MemoryCandidate>>);

impl CandidateCache {
    pub fn lock(&self) -> Result<std::sync::MutexGuard<'_, Vec<MemoryCandidate>>, String> {
        self.0.lock().map_err(|_| "无法访问候选缓存".to_string())
    }
}

impl Default for CandidateCache {
    fn default() -> Self {
        Self(Mutex::new(Vec::new()))
    }
}

/// Analyze incoming content and extract memory candidates.
/// Phase 1: rule-based extraction. Phase 3+: could use LLM.
pub fn extract_candidates(input: &CaptureCandidateInput) -> Vec<MemoryCandidate> {
    let tags = input.tags.clone().unwrap_or_default();
    let confidence = input.confidence.unwrap_or(0.5);

    // Determine memory type
    let memory_type = input.memory_type.clone().unwrap_or({
        match input.source {
            MemorySource::UserExplicit => MemoryType::Profile,
            MemorySource::Conversation => MemoryType::Event,
            MemorySource::ToolResult => MemoryType::Operational,
            MemorySource::TaskOutcome => MemoryType::Event,
            MemorySource::SystemReflection => MemoryType::Reflection,
        }
    });

    // Determine if confirmation is needed
    let requires_confirmation =
        matches!(input.source, MemorySource::Conversation) || confidence < 0.6;

    // Calculate importance
    let importance = match (&memory_type, &input.source) {
        (MemoryType::Profile, MemorySource::UserExplicit) => 8,
        (MemoryType::Profile, _) => 5,
        (MemoryType::Event, MemorySource::TaskOutcome) => 6,
        (MemoryType::Event, _) => 3,
        (MemoryType::Operational, _) => 4,
        (MemoryType::Semantic, _) => 7,
        (MemoryType::Reflection, _) => 5,
    };

    vec![MemoryCandidate {
        id: candidate_id(),
        title: input.title.clone(),
        content: input.content.clone(),
        memory_type,
        source: input.source.clone(),
        confidence,
        importance,
        tags,
        requires_confirmation,
    }]
}

/// Apply a captured candidate to the persistent store.
pub fn apply_candidate(
    db: &MemoryDb,
    input: &ApplyCandidateInput,
    candidates: &mut Vec<MemoryCandidate>,
) -> Result<Option<MemoryItem>, String> {
    let idx = candidates.iter().position(|c| c.id == input.candidate_id);

    let candidate = match idx {
        Some(i) => candidates.remove(i),
        None => return Ok(None),
    };

    if !input.confirmed.unwrap_or(true) {
        return Ok(None);
    }

    let now = now_unix();
    let item = MemoryItem {
        id: format!("memory-{}", candidate.id),
        memory_type: candidate.memory_type.clone(),
        title: candidate.title,
        content: candidate.content,
        source: candidate.source,
        importance: candidate.importance,
        confidence: candidate.confidence,
        recency_score: 1.0,
        privacy_level: PrivacyLevel::PublicToUser,
        status: MemoryStatus::Active,
        created_at: now,
        updated_at: now,
        last_used_at: None,
        expires_at: match candidate.memory_type {
            MemoryType::Event => Some(now + 90 * 86400), // events expire after 90 days
            MemoryType::Operational => Some(now + 60 * 86400),
            _ => None, // profiles and semantic memories persist
        },
        tags: candidate.tags,
        embedding_id: None,
        is_pinned: false,
    };

    db.create(&item)?;
    Ok(Some(item))
}

/// Auto-capture memory candidates from a completed chat exchange.
/// Returns (confirmed_count, pending_count) - confirmed are written directly, pending need user review.
pub fn auto_capture_from_chat(
    db: &MemoryDb,
    cache: &CandidateCache,
    prompt: &str,
    response: &str,
) -> Result<(usize, usize), String> {
    let candidates = extract_chat_candidates(prompt, response);
    let mut confirmed_count = 0;
    let mut pending_count = 0;

    for candidate in candidates {
        if candidate.requires_confirmation {
            // Add to pending cache for user review in MemoryCenter
            let mut locked = cache.lock()?;
            locked.push(candidate);
            pending_count += 1;
        } else {
            // High-confidence task results: write directly
            let now = now_unix();
            let item = MemoryItem {
                id: format!("memory-{}", candidate.id),
                memory_type: candidate.memory_type.clone(),
                title: candidate.title,
                content: candidate.content,
                source: candidate.source,
                importance: candidate.importance,
                confidence: candidate.confidence,
                recency_score: 1.0,
                privacy_level: PrivacyLevel::PublicToUser,
                status: MemoryStatus::Active,
                created_at: now,
                updated_at: now,
                last_used_at: None,
                expires_at: match candidate.memory_type {
                    MemoryType::Event => Some(now + 90 * 86400),
                    MemoryType::Operational => Some(now + 60 * 86400),
                    _ => None,
                },
                tags: candidate.tags,
                embedding_id: None,
                is_pinned: false,
            };
            db.create(&item)?;
            confirmed_count += 1;
        }
    }
    Ok((confirmed_count, pending_count))
}

/// Extract memory candidates from a chat exchange using simple heuristics.
fn extract_chat_candidates(prompt: &str, response: &str) -> Vec<MemoryCandidate> {
    let mut candidates = Vec::new();

    // Heuristic 1: Detect user preferences/facts - requires confirmation
    let preference_markers = [
        "我喜欢",
        "我讨厌",
        "我习惯",
        "我偏好",
        "我每天",
        "我经常",
        "我总是",
        "我从不",
        "我一般",
        "我希望",
        "我需要",
        "我认为",
        "我家住在",
        "我住在",
        "我是",
        "我叫",
    ];
    for marker in &preference_markers {
        if let Some(snippet) = char_window_around(prompt, marker, 10, 80) {
            let snippet = snippet.trim();
            if snippet.len() > 5 {
                candidates.push(MemoryCandidate {
                    id: format!("chat-cand-{}-pref", now_unix()),
                    title: format!("用户偏好：{}", truncate_chars(snippet, 20)),
                    content: snippet.to_string(),
                    memory_type: MemoryType::Profile,
                    source: MemorySource::Conversation,
                    confidence: 0.6,
                    importance: 5,
                    tags: vec!["用户偏好".to_string()],
                    requires_confirmation: true,
                });
                break; // Only one preference candidate per chat
            }
        }
    }

    // Heuristic 2: Detect task outcomes from AI response - high confidence, no confirmation needed
    let outcome_markers = [
        "已创建",
        "已完成",
        "已设置",
        "已删除",
        "已安排",
        "创建成功",
        "设置成功",
        "已为你",
        "已经",
    ];
    for marker in &outcome_markers {
        if response.contains(marker) {
            let context = extract_outcome_context(response, marker);
            if !context.is_empty() {
                candidates.push(MemoryCandidate {
                    id: format!("chat-cand-{}-outcome", now_unix()),
                    title: format!("任务结果：{}", truncate_chars(&context, 20)),
                    content: context,
                    memory_type: MemoryType::Event,
                    source: MemorySource::TaskOutcome,
                    confidence: 0.85,
                    importance: 6,
                    tags: vec!["任务结果".to_string()],
                    requires_confirmation: false, // High confidence, write directly
                });
                break;
            }
        }
    }

    // Heuristic 3: Detect operational knowledge Q&A - requires confirmation
    if prompt.contains("怎么") || prompt.contains("如何") || prompt.contains("怎样") {
        let snippet = truncate_chars(prompt, 50);
        let response_preview = truncate_chars(response, 200);
        candidates.push(MemoryCandidate {
            id: format!("chat-cand-{}-op", now_unix()),
            title: format!("操作知识：{}", snippet),
            content: format!("问：{}\n答：{}", prompt, response_preview),
            memory_type: MemoryType::Operational,
            source: MemorySource::Conversation,
            confidence: 0.5,
            importance: 4,
            tags: vec!["操作知识".to_string()],
            requires_confirmation: true,
        });
    }

    candidates
}

fn extract_outcome_context(response: &str, marker: &str) -> String {
    char_window_around(response, marker, 20, 60)
        .unwrap_or_default()
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_chinese_preference_without_byte_boundary_panics() {
        let candidates = extract_chat_candidates(
            "请记一下，我喜欢早上喝咖啡然后开始写代码。",
            "好的，我会记下这个偏好。",
        );

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].memory_type, MemoryType::Profile);
        assert!(candidates[0].title.starts_with("用户偏好："));
        assert!(candidates[0].content.contains("我喜欢早上喝咖啡"));
    }

    #[test]
    fn extracts_chinese_task_outcome_without_byte_boundary_panics() {
        let candidates =
            extract_chat_candidates("帮我创建提醒", "已创建提醒「提交周报」，时间是明天 18:00。");

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].memory_type, MemoryType::Event);
        assert_eq!(candidates[0].source, MemorySource::TaskOutcome);
        assert!(!candidates[0].requires_confirmation);
    }
}
