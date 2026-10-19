use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: i64 = 6;
pub const DAILY_LIMIT: u32 = 3;
pub const COOLDOWN_SECONDS: i64 = 2 * 60 * 60;
pub const IDLE_STABLE_SECONDS: i64 = 30;
pub const IGNORE_VISIBLE_SECONDS: i64 = 20;
pub const MAX_ACTIVE_LOOPS: u32 = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProactiveCategory {
    TaskUnresolved,
    OpenLoop,
    Greeting,
    Milestone,
    Pattern,
    SmallTalk,
    OutputFeedback,
    DesktopObservation,
}

impl ProactiveCategory {
    pub fn daily_limit(self) -> u32 {
        match self {
            Self::Greeting => 2,
            Self::SmallTalk | Self::DesktopObservation => 3,
            Self::TaskUnresolved => DAILY_LIMIT,
            _ => 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryState {
    Pending,
    Dispatching,
    Shown,
    Responded,
    Dismissed,
    Ignored,
    Revoked,
    Expired,
    Failed,
    Uncertain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenLoopState {
    PendingReview,
    Tracking,
    Due,
    Closed,
    Cancelled,
    Expired,
}

/// IDs and revisions only: never a copy of prompts, tool arguments or output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceRef {
    pub kind: String,
    pub id: String,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProactiveMessage {
    pub id: String,
    pub category: ProactiveCategory,
    pub source: SourceRef,
    pub dedupe_key: String,
    pub template_id: String,
    pub valid_from: i64,
    pub expires_at: i64,
    pub state: DeliveryState,
}

/// Missing activity evidence must suppress delivery, not mean "idle".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivitySnapshot {
    pub observed_at: i64,
    pub locked: Option<bool>,
    pub idle: Option<bool>,
    pub typing: Option<bool>,
    pub agent_busy: Option<bool>,
    pub awaiting_confirmation: Option<bool>,
    pub pet_visible: Option<bool>,
    pub quiet_mode: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleProfile {
    pub profile_id: String,
    pub schema_version: i64,
    pub revision: i64,
    pub default_resource_version: String,
    pub user_overrides: serde_json::Value,
    pub confirmed_evolution: serde_json::Value,
    pub updated_at: i64,
}

/// Startup migration outcome is kept separately from the database: a failed
/// commit must not be mistaken for a healthy schema on subsequent commands.
pub struct SoulBootStatus(pub bool);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SoulStorageState {
    Available,
    Unavailable,
    Volatile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SoulDiagnostics {
    pub storage: SoulStorageState,
    pub schema_version: Option<i64>,
    pub profile_valid: bool,
    pub ledger_readable: bool,
    pub proactive_enabled: bool,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleOverrides {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catchphrases: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forbidden_phrases: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub care: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleContent {
    pub background: String,
    pub values: Vec<String>,
    pub tone: String,
    pub catchphrases: Vec<String>,
    pub forbidden_phrases: Vec<String>,
    pub care: String,
    pub stance: String,
    pub extra: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleSnapshot {
    pub profile_id: String,
    pub schema_version: i64,
    pub revision: i64,
    pub default_resource_version: String,
    pub locale: String,
    pub user_overrides: RoleOverrides,
    pub effective: RoleContent,
    pub writable: bool,
    pub fallback_reason: Option<String>,
    #[serde(default)]
    pub mood: Option<String>,
    #[serde(default)]
    pub nickname: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateRoleInput {
    pub expected_revision: i64,
    pub locale: String,
    pub user_overrides: RoleOverrides,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResetRoleInput {
    pub expected_revision: i64,
    pub locale: String,
    pub clear_evolution_history: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateStatus {
    PendingReview,
    Approved,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenLoopTime {
    pub expression: Option<String>,
    pub baseline: i64,
    pub timezone: String,
    pub starts_at: Option<i64>,
    pub ends_at: Option<i64>,
    pub parser_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenLoop {
    pub id: String,
    pub revision: i64,
    pub content: String,
    pub source: SourceRef,
    pub time: OpenLoopTime,
    pub state: OpenLoopState,
    pub closed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenLoopCandidate {
    pub id: String,
    pub source: SourceRef,
    pub dedupe_key: String,
    pub content: String,
    pub time: OpenLoopTime,
    pub status: CandidateStatus,
    pub created_at: i64,
    pub reviewed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CategorySetting {
    pub category: ProactiveCategory,
    pub enabled: bool,
    pub available: bool,
    pub enabled_since: Option<i64>,
    pub daily_limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SoulSettings {
    pub revision: i64,
    pub enabled: bool,
    pub paused: bool,
    pub enabled_since: Option<i64>,
    pub categories: Vec<CategorySetting>,
    pub mood_enabled: bool,
    pub evolution_enabled: bool,
    pub daily_limit: u32,
    pub cooldown_seconds: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptKind {
    Shown,
    Responded,
    Dismissed,
    Hidden,
    DeliveryFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageReceipt {
    pub message_id: String,
    pub kind: ReceiptKind,
    /// Continuous visible duration, reset by hidden; backend verifies with its
    /// own monotonic clock. Never include time spent queued or hidden.
    pub visible_seconds: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewOpenLoopInput {
    pub candidate_id: String,
    pub decision: CandidateStatus,
    pub content: Option<String>,
    pub time: Option<OpenLoopTime>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateOpenLoopInput {
    pub id: String,
    pub expected_revision: i64,
    pub content: Option<String>,
    pub time: Option<OpenLoopTime>,
    pub state: Option<OpenLoopState>,
}

impl ProactiveCategory {
    pub fn priority(self) -> u8 {
        match self {
            Self::TaskUnresolved => 1,
            Self::OpenLoop => 2,
            Self::Greeting => 3,
            Self::Milestone => 4,
            Self::Pattern => 5,
            Self::SmallTalk => 6,
            Self::OutputFeedback => 7,
            Self::DesktopObservation => 6,
        }
    }

    /// Task and topic windows start at their business deadline, not enqueue time.
    pub fn window_seconds(self) -> i64 {
        match self {
            Self::DesktopObservation => 120,
            Self::Greeting => 30 * 60,
            Self::Pattern | Self::SmallTalk | Self::OutputFeedback => 2 * 60 * 60,
            Self::Milestone => 24 * 60 * 60,
            Self::TaskUnresolved | Self::OpenLoop => 7 * 24 * 60 * 60,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateSoulSettingsInput {
    pub expected_revision: i64,
    pub enabled: Option<bool>,
    pub paused: Option<bool>,
    pub categories: Option<Vec<CategorySetting>>,
    pub mood_enabled: Option<bool>,
    pub evolution_enabled: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SoulDataScope {
    Profile,
    OpenLoops,
    Proactive,
    Mood,
    History,
    All,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClearSoulInput {
    pub scopes: Vec<SoulDataScope>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListOpenLoopsInput {
    pub state: Option<OpenLoopState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenLoopReviewCandidate {
    pub candidate: OpenLoopCandidate,
    pub similar_candidate_ids: Vec<String>,
    pub similar_loop_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenLoopReviewQueue {
    pub candidates: Vec<OpenLoopReviewCandidate>,
    pub active_count: u32,
    pub active_limit: u32,
}

pub const CANDIDATE_RETENTION_SECONDS: i64 = 30 * 86400;
pub const TOPIC_RETENTION_SECONDS: i64 = 90 * 86400;
pub const LEDGER_RETENTION_SECONDS: i64 = 30 * 86400;
