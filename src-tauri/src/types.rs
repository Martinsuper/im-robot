use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    process::Child,
    sync::{
        atomic::{AtomicBool, Arc},
        Mutex,
    },
};
use tauri::AppHandle;

// --- Position / Size ---

#[derive(Debug, Deserialize, Serialize)]
pub struct PetPosition {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct BubbleSize {
    pub width: u32,
    pub height: u32,
}

// --- Settings ---

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub temperature: f32,
    pub timeout_seconds: u64,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            provider: "openai-compatible".to_string(),
            base_url: "http://localhost:11434/v1".to_string(),
            model: "gemma4:e4b".to_string(),
            temperature: 0.7,
            timeout_seconds: 120,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub quiet_mode: String,
    #[serde(default = "default_companion_name")]
    pub companion_name: String,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default)]
    pub sensing_paused: bool,
    #[serde(default)]
    pub ai: AiSettings,
    #[serde(default)]
    pub has_api_key: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            quiet_mode: "balanced".to_string(),
            companion_name: default_companion_name(),
            theme: default_theme(),
            sensing_paused: false,
            ai: AiSettings::default(),
            has_api_key: false,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsInput {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub temperature: f32,
    pub timeout_seconds: u64,
    pub api_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferencesInput {
    pub companion_name: String,
    pub theme: String,
    pub sensing_paused: bool,
}

// --- Chat ---

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistoryEntry {
    pub id: String,
    pub prompt: String,
    pub response: String,
    pub created_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum ChatEvent {
    Started {
        request_id: String,
        working: bool,
    },
    Delta {
        request_id: String,
        sequence: u64,
        text: String,
    },
    Completed {
        request_id: String,
    },
    ActionProposed {
        request_id: String,
        draft: ActionDraft,
    },
    Cancelled {
        request_id: String,
    },
    Failed {
        request_id: String,
        message: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStartInput {
    pub request_id: String,
    pub prompt: String,
    pub attachment_action: Option<String>,
    pub include_screenshot: Option<bool>,
}

// --- Pet Visual Events ---

#[derive(Clone, Debug, Serialize)]
#[serde(
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum PetVisualEvent {
    AttachmentReady,
    ReminderFired { message: String },
    AmbientNudge,
    IdleStarted,
    IdleEnded,
    FocusStarted,
    FocusCompleted,
}

// --- Reminders ---

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub id: String,
    pub title: String,
    pub due_at: u64,
    pub status: String,
    #[serde(default = "default_repeat_rule")]
    pub repeat: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderInput {
    pub title: String,
    pub due_at: u64,
    #[serde(default = "default_repeat_rule")]
    pub repeat: String,
}

#[derive(Clone, Debug)]
pub struct ReminderDeleteInput {
    pub id: String,
    pub title: Option<String>,
    pub due_at: Option<u64>,
    pub repeat: Option<String>,
}

// --- Calendar ---

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub title: String,
    pub start_at: u64,
    pub end_at: u64,
    pub location: Option<String>,
    pub notes: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEventInput {
    pub title: String,
    pub start_at: u64,
    pub end_at: u64,
    pub location: Option<String>,
    pub notes: Option<String>,
}

#[derive(Clone, Debug)]
pub struct CalendarEventBatchInput {
    pub events: Vec<CalendarEventInput>,
}

#[derive(Clone, Debug)]
pub struct CalendarDeleteInput {
    pub id: String,
    pub title: Option<String>,
    pub start_at: Option<u64>,
    pub end_at: Option<u64>,
}

// --- Plugins ---

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginToolManifest {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub risk: String,
    pub confirmation: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub tools: Vec<PluginToolManifest>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub manifest: PluginManifest,
    pub executable: bool,
    pub status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub plugin_id: String,
    pub tool_name: String,
    pub arguments: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionDraft {
    pub id: String,
    pub plugin_id: String,
    pub tool_name: String,
    pub summary: String,
    pub arguments: Value,
    pub created_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionExecution {
    pub message: String,
    pub result: Value,
    pub follow_up_prompt: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct OpenAiToolCallAccumulator {
    pub stream_index: usize,
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum StreamChatOutcome {
    Completed,
    Cancelled,
    ActionProposed,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ProviderKind {
    OpenAiCompatible,
    Anthropic,
    Gemini,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclarativePluginPackage {
    #[serde(flatten)]
    pub manifest: PluginManifest,
    #[serde(default)]
    pub responses: HashMap<String, Value>,
}

// --- Focus Timer ---

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusRecord {
    pub completed_at: u64,
    pub minutes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusSnapshot {
    pub status: String,
    pub kind: String,
    pub remaining_seconds: u64,
    pub today_minutes: u64,
}

#[derive(Clone, Debug)]
pub struct ActiveFocus {
    pub status: String,
    pub kind: String,
    pub end_at: u64,
    pub remaining_seconds: u64,
    pub minutes: u64,
}

// --- Screen Capture ---

#[derive(Clone, Debug)]
pub struct ScreenCapture {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSelection {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotPreview {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
}

// --- Attachments ---

#[derive(Clone, Debug)]
pub struct TextAttachment {
    pub display_name: String,
    pub content: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPreview {
    pub display_name: String,
    pub byte_size: u64,
    pub char_count: usize,
    pub preview: String,
}

// --- Update ---

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub available: bool,
    pub release_url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
}

// --- State Wrappers ---

#[derive(Default)]
pub struct ChatRequests(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

#[derive(Default)]
pub struct ChatContext(pub Mutex<Vec<ChatHistoryEntry>>);

#[derive(Default)]
pub struct LocalTts(pub Mutex<Option<Child>>);

#[derive(Default)]
pub struct TextAttachmentStore(pub Mutex<Option<TextAttachment>>);

#[derive(Default)]
pub struct ScreenCaptureStore(pub Mutex<Option<ScreenCapture>>);

#[derive(Default)]
pub struct FocusTimer(pub Mutex<Option<ActiveFocus>>);

#[derive(Default)]
pub struct IdleDetection(pub Mutex<bool>);

#[derive(Default)]
pub struct ActionDrafts(pub Mutex<HashMap<String, ActionDraft>>);

// --- Plugin Trait ---

pub trait PikoPlugin: Send + Sync {
    fn manifest(&self) -> PluginManifest;
    fn execute(&self, app: &AppHandle, tool: &str, input: Value) -> Result<Value, String>;
}
