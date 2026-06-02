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

/// In-memory cache of pending candidates (not yet persisted).
pub struct CandidateCache(pub Mutex<Vec<MemoryCandidate>>);

impl Default for CandidateCache {
    fn default() -> Self {
        Self(Mutex::new(Vec::new()))
    }
}

/// Analyze incoming content and extract memory candidates.
/// Phase 1: rule-based extraction. Phase 3+: could use LLM.
pub fn extract_candidates(input: &CaptureCandidateInput) -> Vec<MemoryCandidate> {
    let now = now_unix();
    let tags = input.tags.clone().unwrap_or_default();
    let confidence = input.confidence.unwrap_or(0.5);

    // Determine memory type
    let memory_type = input.memory_type.clone().unwrap_or_else(|| {
        match input.source {
            MemorySource::UserExplicit => MemoryType::Profile,
            MemorySource::Conversation => MemoryType::Event,
            MemorySource::ToolResult => MemoryType::Operational,
            MemorySource::TaskOutcome => MemoryType::Event,
            MemorySource::SystemReflection => MemoryType::Reflection,
        }
    });

    // Determine if confirmation is needed
    let requires_confirmation = matches!(input.source, MemorySource::Conversation)
        || confidence < 0.6;

    // Calculate importance
    let importance = match (&memory_type, &input.source) {
        (MemoryType::Profile, MemorySource::UserExplicit) => 8,
        (MemoryType::Profile, _) => 5,
        (MemoryType::Event, MemorySource::TaskOutcome) => 6,
        (MemoryType::Event, _) => 3,
        (MemoryType::Operational, _) => 4,
        (MemoryType::Semantic, _) => 7,
        (MemoryType::Reflection, _) => 5,
        _ => 2,
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
    cache: &CandidateCache,
) -> Result<Option<MemoryItem>, String> {
    let mut candidates = cache
        .0
        .lock()
        .map_err(|_| "无法读取候选缓存".to_string())?;

    let idx = candidates
        .iter()
        .position(|c| c.id == input.candidate_id);

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
        memory_type: candidate.memory_type,
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
