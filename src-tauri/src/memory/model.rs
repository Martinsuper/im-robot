use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ValueRef};
use rusqlite::types::{ToSql, ToSqlOutput};
use serde::{Deserialize, Serialize};

// --- Enums ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum MemoryType {
    Profile,
    Event,
    Semantic,
    Operational,
    Reflection,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum MemorySource {
    UserExplicit,
    Conversation,
    ToolResult,
    TaskOutcome,
    SystemReflection,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PrivacyLevel {
    PublicToUser,
    SensitiveLocalOnly,
    Ephemeral,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum MemoryStatus {
    Active,
    Archived,
    Superseded,
    Deleted,
}

// --- rusqlite ToSql / FromSql implementations ---
// Store enum values as JSON strings (e.g., "profile", "event") in SQLite.

macro_rules! impl_sql_for_enum {
    ($ty:ty) => {
        impl ToSql for $ty {
            fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
                let s = serde_json::to_string(self)
                    .map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))?;
                Ok(ToSqlOutput::from(s))
            }
        }

        impl FromSql for $ty {
            fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
                let s = value.as_str()?;
                serde_json::from_str(s)
                    .map_err(|e| FromSqlError::Other(Box::new(e)))
            }
        }
    };
}

impl_sql_for_enum!(MemoryType);
impl_sql_for_enum!(MemorySource);
impl_sql_for_enum!(PrivacyLevel);
impl_sql_for_enum!(MemoryStatus);

// --- Data model ---

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryItem {
    pub id: String,
    pub memory_type: MemoryType,
    pub title: String,
    pub content: String,
    pub source: MemorySource,
    pub importance: u8,
    pub confidence: f32,
    pub recency_score: f32,
    pub privacy_level: PrivacyLevel,
    pub status: MemoryStatus,
    pub created_at: u64,
    pub updated_at: u64,
    pub last_used_at: Option<u64>,
    pub expires_at: Option<u64>,
    pub tags: Vec<String>,
    pub embedding_id: Option<String>,
}

// --- Input DTOs ---

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMemoryInput {
    pub memory_type: MemoryType,
    pub title: String,
    pub content: String,
    pub source: MemorySource,
    #[serde(default = "default_importance")]
    pub importance: u8,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMemoryInput {
    pub title: Option<String>,
    pub content: Option<String>,
    pub importance: Option<u8>,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ListMemoriesInput {
    pub memory_type: Option<MemoryType>,
    pub status: Option<MemoryStatus>,
    pub limit: Option<usize>,
}

fn default_importance() -> u8 {
    1
}

// --- Display helpers for UI ---

impl MemoryType {
    pub fn label(&self) -> &'static str {
        match self {
            MemoryType::Profile => "用户档案",
            MemoryType::Event => "事件记忆",
            MemoryType::Semantic => "语义知识",
            MemoryType::Operational => "操作记录",
            MemoryType::Reflection => "系统反思",
        }
    }
}

impl MemorySource {
    pub fn label(&self) -> &'static str {
        match self {
            MemorySource::UserExplicit => "用户明确表达",
            MemorySource::Conversation => "对话提取",
            MemorySource::ToolResult => "工具调用结果",
            MemorySource::TaskOutcome => "任务结果",
            MemorySource::SystemReflection => "系统反思",
        }
    }
}
