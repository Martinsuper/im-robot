use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Timelike};
use futures_util::StreamExt;
use screenshots::{image::DynamicImage, Screen};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize,
    State, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use wasmtime::{Engine, Linker, Module, Store};
use wasmtime_wasi::WasiCtxBuilder;

// --- Module declarations for new features ---
pub mod app_awareness;
mod chat;
mod chat_stream;
use chat::*;
mod debounce;
pub mod memory;
mod reminder_schedule;
mod storage;
pub mod sync;
pub mod typing_activity;
use reminder_schedule::next_repeat_due;
use tokio_util::sync::CancellationToken;

const PET_MARGIN: i32 = 16;
/// How many pixels of the pet window stay visible when tucked at screen edge.
const PET_PEEK: i32 = 40;
const PET_MOVE_DEBOUNCE_MS: u64 = 220;
const KEYRING_SERVICE: &str = "com.duanluyao.imrobot";
const KEYRING_ACCOUNT: &str = "provider-api-key";
const MAX_TEXT_ATTACHMENT_BYTES: u64 = 1024 * 1024;
const MAX_TEXT_ATTACHMENT_PREVIEW_CHARS: usize = 240;

#[derive(Debug, Deserialize, Serialize)]
struct PetPosition {
    x: i32,
    y: i32,
}

#[derive(Debug, Deserialize, Serialize)]
struct BubbleSize {
    width: u32,
    height: u32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    quiet_mode: String,
    #[serde(default = "default_companion_name")]
    companion_name: String,
    #[serde(default = "default_theme")]
    theme: String,
    #[serde(default)]
    sensing_paused: bool,
    #[serde(default = "default_break_reminders_enabled")]
    break_reminders_enabled: bool,
    #[serde(default = "default_break_reminder_interval_minutes")]
    break_reminder_interval_minutes: u64,
    #[serde(default = "default_break_reminder_cooldown_minutes")]
    break_reminder_cooldown_minutes: u64,
    #[serde(default = "default_break_reminder_quiet_hours_enabled")]
    break_reminder_quiet_hours_enabled: bool,
    #[serde(default = "default_break_reminder_quiet_hours_start")]
    break_reminder_quiet_hours_start: String,
    #[serde(default = "default_break_reminder_quiet_hours_end")]
    break_reminder_quiet_hours_end: String,
    #[serde(default)]
    ai: AiSettings,
    #[serde(default)]
    has_api_key: bool,
    #[serde(default)]
    html_preview_enabled: bool,
    #[serde(default)]
    onboarding_completed: bool,
    #[serde(default)]
    onboarding_version: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiSettings {
    provider: String,
    base_url: String,
    model: String,
    #[serde(default = "default_speech_model")]
    speech_model: String,
    temperature: f32,
    timeout_seconds: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiSettingsInput {
    provider: String,
    base_url: String,
    model: String,
    speech_model: Option<String>,
    temperature: f32,
    timeout_seconds: u64,
    api_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VoiceTranscriptionInput {
    audio_data_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceTranscriptionOutput {
    text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeechModelStatus {
    id: String,
    name: String,
    file_name: String,
    download_url: String,
    downloaded: bool,
    byte_size: u64,
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadSpeechModelInput {
    model_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeechModelDownloadProgress {
    model_id: String,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    percent: Option<f32>,
    completed: bool,
}

struct SpeechModelDefinition {
    id: &'static str,
    name: &'static str,
    file_name: &'static str,
    download_url: &'static str,
    archive_dir: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatStartInput {
    request_id: String,
    prompt: String,
    attachment_action: Option<String>,
    include_screenshot: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetPersonalityInput {
    energy: f32,
    humor: f32,
    curiosity: f32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetCompanionGenerationInput {
    mode: String,
    scene: String,
    bond_tier: String,
    interaction_type: Option<String>,
    personality: PetPersonalityInput,
    personality_summary: Option<String>,
    context: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PetCompanionGenerationOutput {
    message: Option<String>,
    motion_style: Option<String>,
    behavior_profile: Option<String>,
    behavior_priority: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreferencesInput {
    companion_name: String,
    theme: String,
    sensing_paused: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkRhythmPreferencesInput {
    break_reminders_enabled: bool,
    break_reminder_interval_minutes: u64,
    break_reminder_cooldown_minutes: u64,
    break_reminder_quiet_hours_enabled: bool,
    break_reminder_quiet_hours_start: String,
    break_reminder_quiet_hours_end: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelInfo {
    id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    current_version: String,
    latest_version: String,
    available: bool,
    release_url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatHistoryEntry {
    id: String,
    prompt: String,
    response: String,
    created_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    tag = "type"
)]
enum ChatEvent {
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

/// Emitted when memory candidates are auto-captured from a chat round.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryCapturedEvent {
    confirmed: usize,
    pending: usize,
}

#[derive(Default)]
struct ChatRequests(Mutex<HashMap<String, CancellationToken>>);

#[derive(Default)]
struct ChatContext(Mutex<Vec<ChatHistoryEntry>>);

#[derive(Default)]
struct LocalTts(Mutex<Option<Child>>);

#[derive(Clone, Debug)]
struct TextAttachment {
    display_name: String,
    content: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentPreview {
    display_name: String,
    byte_size: u64,
    char_count: usize,
    preview: String,
}

#[derive(Default)]
struct TextAttachmentStore(Mutex<Option<TextAttachment>>);

#[derive(Clone, Debug)]
struct ScreenCapture {
    data_url: String,
    width: u32,
    height: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureSelection {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotPreview {
    data_url: String,
    width: u32,
    height: u32,
}

#[derive(Default)]
struct ScreenCaptureStore(Mutex<Option<ScreenCapture>>);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Reminder {
    id: String,
    title: String,
    due_at: u64,
    status: String,
    #[serde(default = "default_repeat_rule")]
    repeat: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReminderInput {
    title: String,
    due_at: u64,
    #[serde(default = "default_repeat_rule")]
    repeat: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Memo {
    id: String,
    title: String,
    content: String,
    category: String,
    summary: String,
    tags: Vec<String>,
    created_at: u64,
    updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoInput {
    title: String,
    content: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoSummaryGroup {
    category: String,
    count: usize,
    latest_updated_at: u64,
    summary: String,
    top_tags: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CalendarEvent {
    id: String,
    title: String,
    start_at: u64,
    end_at: u64,
    location: Option<String>,
    notes: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CalendarEventInput {
    title: String,
    start_at: u64,
    end_at: u64,
    location: Option<String>,
    notes: Option<String>,
}

#[derive(Clone, Debug)]
struct CalendarEventBatchInput {
    events: Vec<CalendarEventInput>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginToolManifest {
    name: String,
    description: String,
    input_schema: Value,
    risk: String,
    confirmation: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginManifest {
    id: String,
    name: String,
    version: String,
    description: String,
    tools: Vec<PluginToolManifest>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledPlugin {
    manifest: PluginManifest,
    executable: bool,
    status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolCall {
    plugin_id: String,
    tool_name: String,
    arguments: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActionDraft {
    id: String,
    plugin_id: String,
    tool_name: String,
    summary: String,
    arguments: Value,
    created_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActionExecution {
    message: String,
    result: Value,
    follow_up_prompt: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct OpenAiToolCallAccumulator {
    stream_index: usize,
    id: String,
    name: String,
    arguments: String,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum StreamChatOutcome {
    Completed,
    Cancelled,
    ActionProposed,
}

trait PikoPlugin: Send + Sync {
    fn manifest(&self) -> PluginManifest;
    fn execute(&self, app: &AppHandle, tool: &str, input: Value) -> Result<Value, String>;
}

struct ReminderPlugin;
struct MemoPlugin;
struct CalendarPlugin;

struct PluginRegistry {
    plugins: Mutex<HashMap<String, Arc<dyn PikoPlugin>>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeclarativePluginPackage {
    #[serde(flatten)]
    manifest: PluginManifest,
    #[serde(default)]
    responses: HashMap<String, Value>,
    #[serde(default)]
    runtime: Option<String>,
    #[serde(default)]
    module: Option<String>,
}

struct DeclarativePlugin {
    package: DeclarativePluginPackage,
    directory: PathBuf,
}

#[derive(Default)]
struct ActionDrafts(Mutex<HashMap<String, ActionDraft>>);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FocusRecord {
    completed_at: u64,
    minutes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FocusSnapshot {
    status: String,
    kind: String,
    remaining_seconds: u64,
    today_minutes: u64,
}

#[derive(Clone, Debug)]
struct ActiveFocus {
    status: String,
    kind: String,
    end_at: u64,
    remaining_seconds: u64,
    minutes: u64,
}

#[derive(Default)]
struct FocusTimer(Mutex<Option<ActiveFocus>>);

#[derive(Default)]
struct IdleDetection(Mutex<bool>);

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkRhythmState {
    date: String,
    is_idle: bool,
    idle_seconds: u64,
    active_app_category: String,
    typing_characters_today: u64,
    typing_seconds_today: u64,
    focus_status: String,
    focus_kind: String,
    focus_remaining_seconds: u64,
}

#[derive(Default)]
struct WorkRhythmCache(Mutex<Option<WorkRhythmState>>);

#[derive(Clone, Debug, Default, PartialEq)]
struct WorkRhythmReminderState {
    date: String,
    last_sent_bucket: u64,
    last_notified_at: u64,
}

#[derive(Default)]
struct WorkRhythmReminderCache(Mutex<WorkRhythmReminderState>);

#[derive(Default)]
struct CalendarNotificationCache(Mutex<HashSet<String>>);

fn default_repeat_rule() -> String {
    "none".to_string()
}

impl ReminderPlugin {
    fn tool_manifests() -> Vec<PluginToolManifest> {
        vec![
            PluginToolManifest {
                name: "list_reminders".to_string(),
                description: "列出全部本地提醒，供查询和删除前定位目标".to_string(),
                input_schema: json!({ "type": "object", "properties": {} }),
                risk: "read".to_string(),
                confirmation: "never".to_string(),
            },
            PluginToolManifest {
                name: "create_reminder".to_string(),
                description: "创建一条本地提醒".to_string(),
                input_schema: json!({
                    "type": "object",
                    "required": ["title", "dueAt"],
                    "properties": {
                        "title": { "type": "string", "maxLength": 120 },
                        "dueAt": { "type": "string", "description": "ISO 8601 时间，例如 2026-06-02T15:00:00+08:00" },
                        "repeat": { "enum": ["none", "daily", "weekly", "weekdays"] }
                    }
                }),
                risk: "write".to_string(),
                confirmation: "always".to_string(),
            },
            PluginToolManifest {
                name: "delete_reminder".to_string(),
                description: "删除一条本地提醒，必须先确认目标提醒".to_string(),
                input_schema: json!({
                    "type": "object",
                    "required": ["id"],
                    "properties": {
                        "id": { "type": "string", "description": "提醒 ID" },
                        "title": { "type": "string", "description": "用于确认展示的提醒标题" },
                        "dueAt": { "type": "string", "description": "用于确认展示的提醒时间" },
                        "repeat": { "enum": ["none", "daily", "weekly", "weekdays"] }
                    }
                }),
                risk: "sensitive".to_string(),
                confirmation: "always".to_string(),
            },
        ]
    }
}

impl PikoPlugin for ReminderPlugin {
    fn manifest(&self) -> PluginManifest {
        PluginManifest {
            id: "piko.reminders".to_string(),
            name: "提醒事项".to_string(),
            version: "1.0.0".to_string(),
            description: "创建和管理本地提醒".to_string(),
            tools: Self::tool_manifests(),
        }
    }

    fn execute(&self, app: &AppHandle, tool: &str, input: Value) -> Result<Value, String> {
        match tool {
            "list_reminders" => {
                serde_json::to_value(read_reminders(app)).map_err(|error| error.to_string())
            }
            "create_reminder" => {
                let reminder_input = reminder_input_from_value(&input)?;
                let reminder = create_reminder_record(app, reminder_input)?;
                serde_json::to_value(reminder).map_err(|error| error.to_string())
            }
            "delete_reminder" => {
                let deleted =
                    delete_reminder_record(app, reminder_delete_input_from_value(&input)?)?;
                serde_json::to_value(deleted).map_err(|error| error.to_string())
            }
            _ => Err("提醒插件不支持该工具".to_string()),
        }
    }
}

impl MemoPlugin {
    fn tool_manifests() -> Vec<PluginToolManifest> {
        vec![
            PluginToolManifest {
                name: "list_memos".to_string(),
                description: "列出全部本地备忘录，可用于查询用户已经记录过的备忘".to_string(),
                input_schema: json!({ "type": "object", "properties": {} }),
                risk: "read".to_string(),
                confirmation: "never".to_string(),
            },
            PluginToolManifest {
                name: "create_memo".to_string(),
                description: "创建一条本地备忘录。用户说“记一下”“帮我记”“添加备忘”“写到备忘录”等无需提醒时间的信息时使用。系统会自动分类、摘要和打标签。".to_string(),
                input_schema: json!({
                    "type": "object",
                    "required": ["title", "content"],
                    "properties": {
                        "title": { "type": "string", "maxLength": 120, "description": "简短标题" },
                        "content": { "type": "string", "maxLength": 8000, "description": "要保存的备忘正文" }
                    }
                }),
                risk: "write".to_string(),
                confirmation: "always".to_string(),
            },
        ]
    }
}

impl PikoPlugin for MemoPlugin {
    fn manifest(&self) -> PluginManifest {
        PluginManifest {
            id: "piko.memos".to_string(),
            name: "备忘录".to_string(),
            version: "1.0.0".to_string(),
            description: "创建和查询本地备忘录，并自动汇总分类".to_string(),
            tools: Self::tool_manifests(),
        }
    }

    fn execute(&self, app: &AppHandle, tool: &str, input: Value) -> Result<Value, String> {
        match tool {
            "list_memos" => {
                serde_json::to_value(read_memos(app)).map_err(|error| error.to_string())
            }
            "create_memo" => {
                let memo = create_memo_record(app, memo_input_from_value(&input)?)?;
                serde_json::to_value(memo).map_err(|error| error.to_string())
            }
            _ => Err("备忘录插件不支持该工具".to_string()),
        }
    }
}

impl CalendarPlugin {
    fn tool_manifests() -> Vec<PluginToolManifest> {
        vec![
            PluginToolManifest {
                name: "list_events".to_string(),
                description: "列出全部本地日程，供查询和删除前定位目标".to_string(),
                input_schema: json!({ "type": "object", "properties": {} }),
                risk: "read".to_string(),
                confirmation: "never".to_string(),
            },
            PluginToolManifest {
                name: "detect_conflicts".to_string(),
                description: "检查时间段是否与已有日程冲突".to_string(),
                input_schema: json!({
                    "type": "object",
                    "required": ["startAt", "endAt"],
                    "properties": {
                        "startAt": { "type": "string", "description": "ISO 8601 时间" },
                        "endAt": { "type": "string", "description": "ISO 8601 时间" }
                    }
                }),
                risk: "read".to_string(),
                confirmation: "never".to_string(),
            },
            PluginToolManifest {
                name: "create_event".to_string(),
                description: "创建一条本地日程".to_string(),
                input_schema: json!({
                    "type": "object",
                    "required": ["title", "startAt", "endAt"],
                    "properties": {
                        "title": { "type": "string", "maxLength": 120 },
                        "startAt": { "type": "string", "description": "ISO 8601 时间，例如 2026-06-02T15:00:00+08:00" },
                        "endAt": { "type": "string", "description": "ISO 8601 时间，例如 2026-06-02T16:00:00+08:00" },
                        "location": { "type": "string" },
                        "notes": { "type": "string" }
                    }
                }),
                risk: "write".to_string(),
                confirmation: "always".to_string(),
            },
            PluginToolManifest {
                name: "create_event_batch".to_string(),
                description: "批量创建本地日程，适合日程规划；整批需要用户确认".to_string(),
                input_schema: json!({
                    "type": "object",
                    "required": ["events"],
                    "properties": {
                        "events": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 20,
                            "items": {
                                "type": "object",
                                "required": ["title", "startAt", "endAt"],
                                "properties": {
                                    "title": { "type": "string", "maxLength": 120 },
                                    "startAt": { "type": "string", "description": "ISO 8601 时间，例如 2026-06-02T15:00:00+08:00" },
                                    "endAt": { "type": "string", "description": "ISO 8601 时间，例如 2026-06-02T16:00:00+08:00" },
                                    "location": { "type": "string" },
                                    "notes": { "type": "string" }
                                }
                            }
                        }
                    }
                }),
                risk: "write".to_string(),
                confirmation: "always".to_string(),
            },
            PluginToolManifest {
                name: "delete_event".to_string(),
                description: "删除一条本地日程，必须先确认目标日程".to_string(),
                input_schema: json!({
                    "type": "object",
                    "required": ["id"],
                    "properties": {
                        "id": { "type": "string", "description": "日程 ID" },
                        "title": { "type": "string", "description": "用于确认展示的日程标题" },
                        "startAt": { "type": "string", "description": "用于确认展示的日程开始时间" },
                        "endAt": { "type": "string", "description": "用于确认展示的日程结束时间" }
                    }
                }),
                risk: "sensitive".to_string(),
                confirmation: "always".to_string(),
            },
            PluginToolManifest {
                name: "delete_event_batch".to_string(),
                description: "批量删除本地日程；删除多个或全部日程时使用，必须先调用 list_events 获取目标 ID，整批需要用户确认".to_string(),
                input_schema: json!({
                    "type": "object",
                    "required": ["events"],
                    "properties": {
                        "events": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 100,
                            "items": {
                                "type": "object",
                                "required": ["id"],
                                "properties": {
                                    "id": { "type": "string", "description": "日程 ID" },
                                    "title": { "type": "string", "description": "用于确认展示的日程标题" },
                                    "startAt": { "type": "string", "description": "用于确认展示的日程开始时间" },
                                    "endAt": { "type": "string", "description": "用于确认展示的日程结束时间" }
                                }
                            }
                        }
                    }
                }),
                risk: "sensitive".to_string(),
                confirmation: "always".to_string(),
            },
        ]
    }
}

impl PikoPlugin for CalendarPlugin {
    fn manifest(&self) -> PluginManifest {
        PluginManifest {
            id: "piko.calendar".to_string(),
            name: "日程规划".to_string(),
            version: "1.0.0".to_string(),
            description: "创建、读取和检查本地日程".to_string(),
            tools: Self::tool_manifests(),
        }
    }

    fn execute(&self, app: &AppHandle, tool: &str, input: Value) -> Result<Value, String> {
        match tool {
            "list_events" => {
                serde_json::to_value(read_calendar_events(app)).map_err(|error| error.to_string())
            }
            "detect_conflicts" => {
                let start_at = tool_timestamp(&input["startAt"])?;
                let end_at = tool_timestamp(&input["endAt"])?;
                serde_json::to_value(find_calendar_conflicts(
                    &read_calendar_events(app),
                    start_at,
                    end_at,
                ))
                .map_err(|error| error.to_string())
            }
            "create_event" => {
                let event_input = calendar_event_input_from_value(&input)?;
                let event = create_calendar_event_record(app, event_input)?;
                serde_json::to_value(event).map_err(|error| error.to_string())
            }
            "create_event_batch" => {
                let batch = calendar_event_batch_input_from_value(&input)?;
                let events = create_calendar_event_batch_record(app, batch)?;
                serde_json::to_value(events).map_err(|error| error.to_string())
            }
            "delete_event" => {
                let deleted =
                    delete_calendar_event_record(app, calendar_delete_input_from_value(&input)?)?;
                serde_json::to_value(deleted).map_err(|error| error.to_string())
            }
            "delete_event_batch" => {
                let deleted = delete_calendar_event_batch_record(
                    app,
                    calendar_delete_batch_input_from_value(&input)?,
                )?;
                serde_json::to_value(deleted).map_err(|error| error.to_string())
            }
            _ => Err("日程插件不支持该工具".to_string()),
        }
    }
}

impl PikoPlugin for DeclarativePlugin {
    fn manifest(&self) -> PluginManifest {
        self.package.manifest.clone()
    }

    fn execute(&self, app: &AppHandle, tool: &str, input: Value) -> Result<Value, String> {
        match self.package.runtime.as_deref() {
            Some("wasm") => execute_wasm_plugin(app, &self.directory, &self.package, tool, input),
            _ => self
                .package
                .responses
                .get(tool)
                .cloned()
                .ok_or_else(|| "声明式插件未配置该工具的响应".to_string()),
        }
    }
}

impl PluginRegistry {
    fn with_builtin_plugins() -> Self {
        let reminder_plugin: Arc<dyn PikoPlugin> = Arc::new(ReminderPlugin);
        let memo_plugin: Arc<dyn PikoPlugin> = Arc::new(MemoPlugin);
        let calendar_plugin: Arc<dyn PikoPlugin> = Arc::new(CalendarPlugin);
        let mut plugins = HashMap::new();
        plugins.insert(reminder_plugin.manifest().id, reminder_plugin);
        plugins.insert(memo_plugin.manifest().id, memo_plugin);
        plugins.insert(calendar_plugin.manifest().id, calendar_plugin);
        Self {
            plugins: Mutex::new(plugins),
        }
    }

    fn manifests(&self) -> Vec<PluginManifest> {
        let Ok(plugins) = self.plugins.lock() else {
            return Vec::new();
        };
        let mut manifests = plugins
            .values()
            .map(|plugin| plugin.manifest())
            .collect::<Vec<_>>();
        manifests.sort_by(|left, right| left.id.cmp(&right.id));
        manifests
    }

    fn execute(&self, app: &AppHandle, call: ToolCall) -> Result<Value, String> {
        let plugins = self
            .plugins
            .lock()
            .map_err(|_| "无法读取业务插件".to_string())?;
        let plugin = plugins
            .get(&call.plugin_id)
            .ok_or_else(|| "未找到对应的业务插件".to_string())?;
        let manifest = plugin.manifest();
        if !manifest
            .tools
            .iter()
            .any(|tool| tool.name == call.tool_name)
        {
            return Err("插件未声明该工具".to_string());
        }
        plugin.execute(app, &call.tool_name, call.arguments)
    }

    fn tool_manifest(&self, call: &ToolCall) -> Result<PluginToolManifest, String> {
        self.plugins
            .lock()
            .map_err(|_| "无法读取业务插件".to_string())?
            .get(&call.plugin_id)
            .ok_or_else(|| "未找到对应的业务插件".to_string())?
            .manifest()
            .tools
            .into_iter()
            .find(|tool| tool.name == call.tool_name)
            .ok_or_else(|| "插件未声明该工具".to_string())
    }

    fn decode_tool_call(&self, wire_name: &str, arguments: Value) -> Result<ToolCall, String> {
        for manifest in self.manifests() {
            for tool in manifest.tools {
                if plugin_wire_name(&manifest.id, &tool.name) == wire_name {
                    return Ok(ToolCall {
                        plugin_id: manifest.id,
                        tool_name: tool.name,
                        arguments,
                    });
                }
            }
        }
        Err("模型请求了未注册的工具".to_string())
    }

    fn register_declarative_plugins(&self, app: &AppHandle) -> Vec<InstalledPlugin> {
        let packages = read_external_plugin_packages(app);
        let mut plugins = match self.plugins.lock() {
            Ok(plugins) => plugins,
            Err(_) => return Vec::new(),
        };
        let mut installed = Vec::new();
        for package in packages {
            let error = validate_declarative_plugin(&package.package).err();
            let executable = error.is_none();
            let runtime = package.package.runtime.as_deref().unwrap_or("declarative");
            let status = error.unwrap_or_else(|| match runtime {
                "wasm" => "已启用 WASM 沙箱运行时".to_string(),
                _ => "已启用声明式只读运行时".to_string(),
            });
            if executable && !plugins.contains_key(&package.package.manifest.id) {
                plugins.insert(
                    package.package.manifest.id.clone(),
                    Arc::new(DeclarativePlugin {
                        package: package.package.clone(),
                        directory: package.directory.clone(),
                    }),
                );
            }
            installed.push(InstalledPlugin {
                manifest: package.package.manifest,
                executable,
                status,
            });
        }
        installed.sort_by(|left, right| left.manifest.id.cmp(&right.manifest.id));
        installed
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    tag = "type"
)]
enum PetVisualEvent {
    AttachmentReady,
    ReminderFired { message: String },
    CalendarEventDue { message: String },
    AmbientNudge,
    BreakReminder { message: String },
    IdleStarted,
    IdleEnded,
    FocusStarted,
    FocusCompleted,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            quiet_mode: "balanced".to_string(),
            companion_name: default_companion_name(),
            theme: default_theme(),
            sensing_paused: false,
            break_reminders_enabled: default_break_reminders_enabled(),
            break_reminder_interval_minutes: default_break_reminder_interval_minutes(),
            break_reminder_cooldown_minutes: default_break_reminder_cooldown_minutes(),
            break_reminder_quiet_hours_enabled: default_break_reminder_quiet_hours_enabled(),
            break_reminder_quiet_hours_start: default_break_reminder_quiet_hours_start(),
            break_reminder_quiet_hours_end: default_break_reminder_quiet_hours_end(),
            ai: AiSettings::default(),
            has_api_key: false,
            html_preview_enabled: false,
            onboarding_completed: false,
            onboarding_version: String::new(),
        }
    }
}

fn default_companion_name() -> String {
    "Piko".to_string()
}

fn default_theme() -> String {
    "sage".to_string()
}

fn default_break_reminders_enabled() -> bool {
    true
}

fn default_break_reminder_interval_minutes() -> u64 {
    45
}

fn default_break_reminder_cooldown_minutes() -> u64 {
    30
}

fn default_break_reminder_quiet_hours_enabled() -> bool {
    false
}

fn default_break_reminder_quiet_hours_start() -> String {
    "22:00".to_string()
}

fn default_break_reminder_quiet_hours_end() -> String {
    "08:00".to_string()
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            provider: "openai-compatible".to_string(),
            base_url: "http://localhost:11434/v1".to_string(),
            model: "gemma4:e4b".to_string(),
            speech_model: default_speech_model(),
            temperature: 0.7,
            timeout_seconds: 120,
        }
    }
}

fn default_speech_model() -> String {
    "sense-voice".to_string()
}

fn speech_model_definitions() -> &'static [SpeechModelDefinition] {
    &[SpeechModelDefinition {
        id: "sense-voice",
        name: "SenseVoice 中文优化",
        file_name: "model.int8.onnx",
        download_url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2",
        archive_dir: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
    }]
}

fn speech_model_definition(model_id: &str) -> Option<&'static SpeechModelDefinition> {
    speech_model_definitions()
        .iter()
        .find(|model| model.id == model_id)
}

fn pet_position_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("pet-position.json"))
}

fn bubble_size_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("bubble-size.json"))
}

fn app_settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("app-settings.json"))
}

fn chat_history_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("chat-history.json"))
}

fn reminders_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("reminders.json"))
}

fn memos_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("memos.json"))
}

fn calendar_events_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("calendar-events.json"))
}

fn external_plugins_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("plugins"))
}

fn focus_records_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("focus-records.json"))
}

fn read_chat_history(app: &AppHandle) -> Vec<ChatHistoryEntry> {
    chat_history_path(app)
        .map(|path| storage::read_or_default(&path))
        .unwrap_or_default()
}

fn persist_chat_history(app: &AppHandle, history: &[ChatHistoryEntry]) -> Result<(), String> {
    let path = chat_history_path(app).ok_or("无法获取数据路径")?;
    storage::write(&path, history)
}

fn append_chat_history(app: &AppHandle, entry: ChatHistoryEntry) -> Result<(), String> {
    let _transaction = storage::transaction();
    const MAX_CHAT_HISTORY: usize = 50;

    let mut history = read_chat_history(app);
    history.insert(0, entry);
    history.truncate(MAX_CHAT_HISTORY);
    persist_chat_history(app, &history)
}

fn append_session_chat_history(history: &mut Vec<ChatHistoryEntry>, entry: ChatHistoryEntry) {
    const MAX_SESSION_CHAT_HISTORY: usize = 10;

    history.insert(0, entry);
    history.truncate(MAX_SESSION_CHAT_HISTORY);
}

fn read_reminders(app: &AppHandle) -> Vec<Reminder> {
    reminders_path(app)
        .map(|path| storage::read_or_default(&path))
        .unwrap_or_default()
}

fn persist_reminders(app: &AppHandle, reminders: &[Reminder]) -> Result<(), String> {
    let path = reminders_path(app).ok_or("无法获取数据路径")?;
    storage::write(&path, reminders)
}

fn read_memos(app: &AppHandle) -> Vec<Memo> {
    memos_path(app)
        .map(|path| storage::read_or_default(&path))
        .unwrap_or_default()
}

fn persist_memos(app: &AppHandle, memos: &[Memo]) -> Result<(), String> {
    let path = memos_path(app).ok_or("无法获取数据路径")?;
    storage::write(&path, memos)
}

fn read_calendar_events(app: &AppHandle) -> Vec<CalendarEvent> {
    calendar_events_path(app)
        .map(|path| read_calendar_events_from_path(&path))
        .unwrap_or_default()
}

fn read_calendar_events_from_path(path: &Path) -> Vec<CalendarEvent> {
    storage::read_or_default(path)
}

fn persist_calendar_events(app: &AppHandle, events: &[CalendarEvent]) -> Result<(), String> {
    let _transaction = storage::transaction();
    let path = calendar_events_path(app).ok_or_else(|| "无法获取日程记录路径".to_string())?;
    persist_calendar_events_to_path(&path, events)
}

fn persist_calendar_events_to_path(path: &Path, events: &[CalendarEvent]) -> Result<(), String> {
    storage::write(path, events)
}

struct ExternalPluginPackage {
    directory: PathBuf,
    package: DeclarativePluginPackage,
}

fn read_external_plugin_packages(app: &AppHandle) -> Vec<ExternalPluginPackage> {
    let Some(directory) = external_plugins_path(app) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path().join("manifest.json");
            fs::read_to_string(path)
                .ok()
                .and_then(|json| serde_json::from_str::<DeclarativePluginPackage>(&json).ok())
                .map(|package| ExternalPluginPackage {
                    directory: entry.path(),
                    package,
                })
        })
        .collect()
}

fn validate_declarative_plugin(package: &DeclarativePluginPackage) -> Result<(), String> {
    if !package.manifest.id.starts_with("piko.external.") || package.manifest.id.contains("..") {
        return Err("外部插件 ID 必须以 piko.external. 开头".to_string());
    }
    if package.manifest.tools.is_empty() {
        return Err("外部插件必须声明至少一个工具".to_string());
    }
    let runtime = package.runtime.as_deref().unwrap_or("declarative");
    if !matches!(runtime, "declarative" | "wasm") {
        return Err("外部插件 runtime 仅支持 declarative 或 wasm".to_string());
    }
    if runtime == "wasm" && package.module.as_deref().unwrap_or("").is_empty() {
        return Err("WASM 插件必须指定 module 文件".to_string());
    }
    if runtime == "wasm" {
        let module = package.module.as_deref().unwrap_or("");
        if !module.ends_with(".wasm") {
            return Err("WASM 插件 module 必须以 .wasm 结尾".to_string());
        }
    }
    for tool in &package.manifest.tools {
        if runtime == "declarative"
            && (!matches!(tool.risk.as_str(), "pure" | "read") || tool.confirmation != "never")
        {
            return Err("声明式插件只允许 pure/read 且无需确认的工具".to_string());
        }
        if runtime == "wasm"
            && !matches!(tool.risk.as_str(), "pure" | "read" | "write" | "sensitive")
        {
            return Err("WASM 插件工具风险等级不合法".to_string());
        }
        if runtime == "declarative" && !package.responses.contains_key(&tool.name) {
            return Err(format!("工具 {} 缺少静态响应", tool.name));
        }
    }
    Ok(())
}

fn execute_wasm_plugin(
    _app: &AppHandle,
    directory: &Path,
    package: &DeclarativePluginPackage,
    tool: &str,
    input: Value,
) -> Result<Value, String> {
    let module_name = package.module.as_deref().unwrap_or("plugin.wasm");
    let module_path = directory.join(module_name);
    if !module_path.exists() {
        return Err(format!("WASM 插件模块不存在：{}", module_path.display()));
    }

    let engine = Engine::default();
    let module = Module::from_file(&engine, &module_path).map_err(|e| e.to_string())?;
    let mut linker = Linker::<wasmtime_wasi::p1::WasiP1Ctx>::new(&engine);
    wasmtime_wasi::p1::add_to_linker_sync(&mut linker, |ctx| ctx).map_err(|e| e.to_string())?;
    let plugin_id = package.manifest.id.clone();
    let manifest = package.manifest.clone();

    let stdin_payload = serde_json::to_vec(&json!({
        "pluginId": plugin_id,
        "toolName": tool,
        "arguments": input,
        "manifest": manifest,
    }))
    .map_err(|e| e.to_string())?;
    let stdin = wasmtime_wasi::p2::pipe::MemoryInputPipe::new(stdin_payload);
    let stdout = wasmtime_wasi::p2::pipe::MemoryOutputPipe::new(1024 * 1024);
    let stderr = wasmtime_wasi::p2::pipe::MemoryOutputPipe::new(256 * 1024);

    let wasi = WasiCtxBuilder::new()
        .stdin(stdin)
        .stdout(stdout.clone())
        .stderr(stderr.clone())
        .build_p1();
    let mut store = Store::new(&engine, wasi);
    let instance = linker
        .instantiate(&mut store, &module)
        .map_err(|e| e.to_string())?;
    let start = instance
        .get_typed_func::<(), ()>(&mut store, "_start")
        .map_err(|e| e.to_string())?;
    start.call(&mut store, ()).map_err(|e| e.to_string())?;

    let stdout_text = String::from_utf8(stdout.contents().to_vec()).map_err(|e| e.to_string())?;
    let stderr_text = String::from_utf8(stderr.contents().to_vec()).unwrap_or_default();
    let output = stdout_text.trim();
    if output.is_empty() {
        return Ok(json!({
            "ok": true,
            "pluginId": plugin_id.clone(),
            "toolName": tool,
            "stderr": stderr_text,
        }));
    }

    match serde_json::from_str::<Value>(output) {
        Ok(value) => Ok(value),
        Err(_) => Ok(json!({
            "ok": true,
            "pluginId": plugin_id,
            "toolName": tool,
            "stderr": stderr_text,
            "raw": output,
        })),
    }
}

fn read_focus_records(app: &AppHandle) -> Vec<FocusRecord> {
    focus_records_path(app)
        .map(|path| storage::read_or_default(&path))
        .unwrap_or_default()
}

fn persist_focus_records(app: &AppHandle, records: &[FocusRecord]) -> Result<(), String> {
    let path = focus_records_path(app).ok_or("无法获取数据路径")?;
    storage::write(&path, records)
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn reminder_id() -> String {
    format!(
        "reminder-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

fn memo_id() -> String {
    format!(
        "memo-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

fn calendar_event_id() -> String {
    format!(
        "calendar-event-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

fn action_draft_id() -> String {
    format!(
        "action-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

fn repeat_rule_label(repeat: &str) -> &str {
    match repeat {
        "daily" => "每天",
        "weekly" => "每周",
        "weekdays" => "工作日",
        _ => "仅一次",
    }
}

fn find_calendar_conflicts(
    events: &[CalendarEvent],
    start_at: u64,
    end_at: u64,
) -> Vec<CalendarEvent> {
    events
        .iter()
        .filter(|event| event.start_at < end_at && start_at < event.end_at)
        .cloned()
        .collect()
}

fn plugin_wire_name(plugin_id: &str, tool_name: &str) -> String {
    format!("{}__{tool_name}", plugin_id.replace('.', "_"))
}

fn provider_tools(provider: &str, manifests: &[PluginManifest]) -> Value {
    let tools = manifests
        .iter()
        .flat_map(|manifest| {
            manifest.tools.iter().map(|tool| {
                let name = plugin_wire_name(&manifest.id, &tool.name);
                match provider_kind(provider) {
                    Some(ProviderKind::Anthropic) => json!({
                        "name": name,
                        "description": tool.description,
                        "input_schema": tool.input_schema,
                    }),
                    _ => json!({
                        "type": "function",
                        "function": {
                            "name": name,
                            "description": tool.description,
                            "parameters": tool.input_schema,
                        }
                    }),
                }
            })
        })
        .collect::<Vec<_>>();
    if provider_kind(provider) == Some(ProviderKind::Gemini) {
        json!([{ "functionDeclarations": tools.into_iter().map(|tool| tool["function"].clone()).collect::<Vec<_>>() }])
    } else {
        Value::Array(tools)
    }
}

fn append_provider_tools(body: &mut Value, provider: &str, manifests: &[PluginManifest]) {
    match provider_kind(provider) {
        Some(ProviderKind::OpenAiCompatible | ProviderKind::Anthropic) => {
            body["tools"] = provider_tools(provider, manifests);
        }
        Some(ProviderKind::Gemini) => {
            body["tools"] = provider_tools(provider, manifests);
        }
        None => {}
    }
}

fn update_openai_tool_calls(line: &str, calls: &mut Vec<OpenAiToolCallAccumulator>) {
    let Some(data) = line.strip_prefix("data:") else {
        return;
    };
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return;
    }
    let Ok(body) = serde_json::from_str::<Value>(data) else {
        return;
    };
    let Some(tool_calls) = body["choices"][0]["delta"]["tool_calls"].as_array() else {
        return;
    };
    for tool_call in tool_calls {
        let index = tool_call["index"].as_u64().unwrap_or(0) as usize;
        while calls.len() <= index {
            calls.push(OpenAiToolCallAccumulator::default());
        }
        let call = &mut calls[index];
        call.stream_index = index;
        if let Some(id) = tool_call["id"].as_str() {
            call.id.push_str(id);
        }
        if let Some(name) = tool_call["function"]["name"].as_str() {
            call.name.push_str(name);
        }
        if let Some(arguments) = tool_call["function"]["arguments"].as_str() {
            call.arguments.push_str(arguments);
        }
    }
}

fn update_anthropic_tool_calls(line: &str, calls: &mut Vec<OpenAiToolCallAccumulator>) {
    let Some(data) = line.strip_prefix("data:") else {
        return;
    };
    let Ok(body) = serde_json::from_str::<Value>(data.trim()) else {
        return;
    };
    let is_start =
        body["type"] == "content_block_start" && body["content_block"]["type"] == "tool_use";
    let is_delta =
        body["type"] == "content_block_delta" && body["delta"]["type"] == "input_json_delta";
    if !is_start && !is_delta {
        return;
    }
    let index = body["index"].as_u64().unwrap_or(0) as usize;
    if is_start {
        calls.push(OpenAiToolCallAccumulator {
            stream_index: index,
            ..Default::default()
        });
    }
    let Some(call) = calls.iter_mut().find(|call| call.stream_index == index) else {
        return;
    };
    if is_start {
        call.id = body["content_block"]["id"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        call.name = body["content_block"]["name"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        call.arguments = body["content_block"]["input"].to_string();
    }
    if is_delta {
        if call.arguments == "{}" {
            call.arguments.clear();
        }
        call.arguments
            .push_str(body["delta"]["partial_json"].as_str().unwrap_or_default());
    }
}

fn update_gemini_tool_calls(line: &str, calls: &mut Vec<OpenAiToolCallAccumulator>) {
    let Some(data) = line.strip_prefix("data:") else {
        return;
    };
    let Ok(body) = serde_json::from_str::<Value>(data.trim()) else {
        return;
    };
    let Some(parts) = body["candidates"][0]["content"]["parts"].as_array() else {
        return;
    };
    for part in parts {
        let Some(name) = part["functionCall"]["name"].as_str() else {
            continue;
        };
        let call = OpenAiToolCallAccumulator {
            stream_index: calls.len(),
            id: format!("gemini-call-{}", calls.len()),
            name: name.to_string(),
            arguments: part["functionCall"]["args"].to_string(),
        };
        if !calls
            .iter()
            .any(|existing| existing.name == call.name && existing.arguments == call.arguments)
        {
            calls.push(call);
        }
    }
}

fn update_provider_tool_calls(
    provider: &str,
    line: &str,
    calls: &mut Vec<OpenAiToolCallAccumulator>,
) {
    match provider_kind(provider) {
        Some(ProviderKind::Anthropic) => update_anthropic_tool_calls(line, calls),
        Some(ProviderKind::Gemini) => update_gemini_tool_calls(line, calls),
        _ => update_openai_tool_calls(line, calls),
    }
}

fn decode_openai_tool_calls(
    registry: &PluginRegistry,
    calls: Vec<OpenAiToolCallAccumulator>,
) -> Result<Vec<(String, ToolCall)>, String> {
    calls
        .into_iter()
        .map(|call| {
            if call.id.is_empty() || call.name.is_empty() {
                return Err("模型返回的工具调用不完整".to_string());
            }
            let arguments = serde_json::from_str(&call.arguments)
                .map_err(|_| "工具参数不是有效 JSON".to_string())?;
            Ok((call.id, registry.decode_tool_call(&call.name, arguments)?))
        })
        .collect()
}

fn coalesce_calendar_delete_calls(calls: Vec<(String, ToolCall)>) -> Vec<(String, ToolCall)> {
    let delete_count = calls
        .iter()
        .filter(|(_, call)| call.plugin_id == "piko.calendar" && call.tool_name == "delete_event")
        .count();
    if delete_count <= 1 {
        return calls;
    }

    let events = calls
        .iter()
        .filter(|(_, call)| call.plugin_id == "piko.calendar" && call.tool_name == "delete_event")
        .map(|(_, call)| call.arguments.clone())
        .collect::<Vec<_>>();
    let mut batch = Some(events);
    calls
        .into_iter()
        .filter_map(|(id, mut call)| {
            if call.plugin_id != "piko.calendar" || call.tool_name != "delete_event" {
                return Some((id, call));
            }
            let events = batch.take()?;
            call.tool_name = "delete_event_batch".to_string();
            call.arguments = json!({ "events": events });
            Some((id, call))
        })
        .collect()
}

fn append_provider_tool_results(
    request_body: &mut Value,
    provider: &str,
    calls: &[(String, ToolCall, Value)],
) -> Result<(), String> {
    match provider_kind(provider) {
        Some(ProviderKind::OpenAiCompatible) => {
            let messages = request_body["messages"]
                .as_array_mut()
                .ok_or_else(|| "模型请求消息格式无效".to_string())?;
            messages.push(json!({
                "role": "assistant",
                "content": null,
                "tool_calls": calls.iter().map(|(id, call, _)| json!({
                    "id": id,
                    "type": "function",
                    "function": {
                        "name": plugin_wire_name(&call.plugin_id, &call.tool_name),
                        "arguments": serde_json::to_string(&call.arguments).unwrap_or_default(),
                    }
                })).collect::<Vec<_>>(),
            }));
            messages.extend(calls.iter().map(|(id, _, result)| {
                json!({
                    "role": "tool",
                    "tool_call_id": id,
                    "content": serde_json::to_string(result).unwrap_or_default(),
                })
            }));
        }
        Some(ProviderKind::Anthropic) => {
            let messages = request_body["messages"]
                .as_array_mut()
                .ok_or_else(|| "模型请求消息格式无效".to_string())?;
            messages.push(json!({
                "role": "assistant",
                "content": calls.iter().map(|(id, call, _)| json!({
                    "type": "tool_use",
                    "id": id,
                    "name": plugin_wire_name(&call.plugin_id, &call.tool_name),
                    "input": call.arguments,
                })).collect::<Vec<_>>(),
            }));
            messages.push(json!({
                "role": "user",
                "content": calls.iter().map(|(id, _, result)| json!({
                    "type": "tool_result",
                    "tool_use_id": id,
                    "content": serde_json::to_string(result).unwrap_or_default(),
                })).collect::<Vec<_>>(),
            }));
        }
        Some(ProviderKind::Gemini) => {
            let contents = request_body["contents"]
                .as_array_mut()
                .ok_or_else(|| "模型请求消息格式无效".to_string())?;
            contents.push(json!({
                "role": "model",
                "parts": calls.iter().map(|(_, call, _)| json!({
                    "functionCall": {
                        "name": plugin_wire_name(&call.plugin_id, &call.tool_name),
                        "args": call.arguments,
                    }
                })).collect::<Vec<_>>(),
            }));
            contents.push(json!({
                "role": "user",
                "parts": calls.iter().map(|(_, call, result)| json!({
                    "functionResponse": {
                        "name": plugin_wire_name(&call.plugin_id, &call.tool_name),
                        "response": result,
                    }
                })).collect::<Vec<_>>(),
            }));
        }
        None => return Err("不支持的模型服务类型".to_string()),
    }
    Ok(())
}

fn tool_timestamp(value: &Value) -> Result<u64, String> {
    if let Some(timestamp) = value.as_u64() {
        return Ok(timestamp);
    }

    let raw = value
        .as_str()
        .ok_or_else(|| "时间必须是 ISO 8601 字符串".to_string())?;
    if let Ok(parsed) = DateTime::parse_from_rfc3339(raw) {
        return u64::try_from(parsed.timestamp()).map_err(|_| "时间不能早于 1970 年".to_string());
    }

    let parsed = NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S"))
        .or_else(|_| NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M"))
        .or_else(|_| NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M"))
        .map_err(|_| "时间必须是 ISO 8601 格式".to_string())?;
    let parsed = Local
        .from_local_datetime(&parsed)
        .single()
        .ok_or_else(|| "本地时间无效，请提供带时区的 ISO 8601 时间".to_string())?;
    u64::try_from(parsed.timestamp()).map_err(|_| "时间不能早于 1970 年".to_string())
}

fn reminder_input_from_value(value: &Value) -> Result<ReminderInput, String> {
    let title = value["title"]
        .as_str()
        .ok_or_else(|| "提醒标题不能为空".to_string())?
        .to_string();
    let due_at = tool_timestamp(&value["dueAt"])?;
    let repeat = value["repeat"].as_str().unwrap_or("none").to_string();
    Ok(ReminderInput {
        title,
        due_at,
        repeat,
    })
}

fn memo_input_from_value(value: &Value) -> Result<MemoInput, String> {
    let title = value["title"]
        .as_str()
        .ok_or_else(|| "备忘录标题不能为空".to_string())?
        .to_string();
    let content = value["content"]
        .as_str()
        .ok_or_else(|| "备忘录内容不能为空".to_string())?
        .to_string();
    Ok(MemoInput { title, content })
}

fn calendar_event_input_from_value(value: &Value) -> Result<CalendarEventInput, String> {
    let title = value["title"]
        .as_str()
        .ok_or_else(|| "日程标题不能为空".to_string())?
        .to_string();
    let start_at = tool_timestamp(&value["startAt"])?;
    let end_at = tool_timestamp(&value["endAt"])?;
    let location = value["location"].as_str().map(str::to_string);
    let notes = value["notes"].as_str().map(str::to_string);
    Ok(CalendarEventInput {
        title,
        start_at,
        end_at,
        location,
        notes,
    })
}

fn calendar_event_batch_input_from_value(value: &Value) -> Result<CalendarEventBatchInput, String> {
    let events = value["events"]
        .as_array()
        .ok_or_else(|| "批量日程必须包含 events 数组".to_string())?;
    if events.is_empty() || events.len() > 20 {
        return Err("批量日程数量必须在 1 到 20 之间".to_string());
    }
    Ok(CalendarEventBatchInput {
        events: events
            .iter()
            .map(calendar_event_input_from_value)
            .collect::<Result<Vec<_>, _>>()?,
    })
}

fn format_tool_timestamp(value: Option<u64>) -> Option<String> {
    value.and_then(|timestamp| {
        Local
            .timestamp_opt(timestamp as i64, 0)
            .single()
            .map(|date_time| date_time.format("%Y-%m-%d %H:%M").to_string())
    })
}

#[derive(Clone, Debug)]
struct ReminderDeleteInput {
    id: String,
    title: Option<String>,
    due_at: Option<u64>,
    repeat: Option<String>,
}

#[derive(Clone, Debug)]
struct CalendarDeleteInput {
    id: String,
    title: Option<String>,
    start_at: Option<u64>,
    end_at: Option<u64>,
}

#[derive(Clone, Debug)]
struct CalendarDeleteBatchInput {
    events: Vec<CalendarDeleteInput>,
}

fn reminder_delete_input_from_value(value: &Value) -> Result<ReminderDeleteInput, String> {
    let id = value["id"]
        .as_str()
        .ok_or_else(|| "提醒 ID 不能为空".to_string())?
        .to_string();
    Ok(ReminderDeleteInput {
        id,
        title: value["title"].as_str().map(str::to_string),
        due_at: value["dueAt"].as_str().and_then(tool_timestamp_str),
        repeat: value["repeat"].as_str().map(str::to_string),
    })
}

fn calendar_delete_input_from_value(value: &Value) -> Result<CalendarDeleteInput, String> {
    let id = value["id"]
        .as_str()
        .ok_or_else(|| "日程 ID 不能为空".to_string())?
        .to_string();
    Ok(CalendarDeleteInput {
        id,
        title: value["title"].as_str().map(str::to_string),
        start_at: value["startAt"].as_str().and_then(tool_timestamp_str),
        end_at: value["endAt"].as_str().and_then(tool_timestamp_str),
    })
}

fn calendar_delete_batch_input_from_value(
    value: &Value,
) -> Result<CalendarDeleteBatchInput, String> {
    let events = value["events"]
        .as_array()
        .ok_or_else(|| "批量删除日程必须包含 events 数组".to_string())?;
    if events.is_empty() || events.len() > 100 {
        return Err("批量删除日程数量必须在 1 到 100 之间".to_string());
    }
    Ok(CalendarDeleteBatchInput {
        events: events
            .iter()
            .map(calendar_delete_input_from_value)
            .collect::<Result<Vec<_>, _>>()?,
    })
}

fn tool_timestamp_str(value: &str) -> Option<u64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date_time| date_time.timestamp().max(0) as u64)
}

fn action_draft_from_tool_call(
    call: &ToolCall,
    now: DateTime<Local>,
) -> Result<ActionDraft, String> {
    let summary = match (call.plugin_id.as_str(), call.tool_name.as_str()) {
        ("piko.reminders", "create_reminder") => {
            let input = reminder_input_from_value(&call.arguments)?;
            let formatted_due_at = Local
                .timestamp_opt(input.due_at as i64, 0)
                .single()
                .ok_or_else(|| "提醒时间无效".to_string())?
                .format("%Y-%m-%d %H:%M")
                .to_string();
            format!(
                "创建提醒「{}」\n时间：{formatted_due_at}\n重复：{}",
                input.title,
                repeat_rule_label(&input.repeat)
            )
        }
        ("piko.reminders", "delete_reminder") => {
            let input = reminder_delete_input_from_value(&call.arguments)?;
            let title = input.title.unwrap_or_else(|| format!("ID {}", input.id));
            let due_at = format_tool_timestamp(input.due_at)
                .map(|value| format!("\n时间：{value}"))
                .unwrap_or_default();
            let repeat = input
                .repeat
                .as_deref()
                .map(repeat_rule_label)
                .map(|label| format!("\n重复：{label}"))
                .unwrap_or_default();
            format!("删除提醒「{title}」{due_at}{repeat}")
        }
        ("piko.memos", "create_memo") => {
            let input = memo_input_from_value(&call.arguments)?;
            let preview = summarize_memo(&input.title, &input.content);
            let category = infer_memo_category(&input.title, &input.content);
            format!(
                "创建备忘录「{}」\n分类：{}\n摘要：{}",
                input.title,
                memo_category_label(&category),
                preview
            )
        }
        ("piko.calendar", "create_event") => {
            let input = calendar_event_input_from_value(&call.arguments)?;
            let formatted_start = Local
                .timestamp_opt(input.start_at as i64, 0)
                .single()
                .ok_or_else(|| "日程开始时间无效".to_string())?
                .format("%Y-%m-%d %H:%M")
                .to_string();
            let formatted_end = Local
                .timestamp_opt(input.end_at as i64, 0)
                .single()
                .ok_or_else(|| "日程结束时间无效".to_string())?
                .format("%Y-%m-%d %H:%M")
                .to_string();
            format!(
                "创建日程「{}」\n时间：{formatted_start} - {formatted_end}",
                input.title
            )
        }
        ("piko.calendar", "delete_event") => {
            let input = calendar_delete_input_from_value(&call.arguments)?;
            let title = input.title.unwrap_or_else(|| format!("ID {}", input.id));
            let range = match (
                format_tool_timestamp(input.start_at),
                format_tool_timestamp(input.end_at),
            ) {
                (Some(start), Some(end)) => format!("\n时间：{start} - {end}"),
                _ => String::new(),
            };
            format!("删除日程「{title}」{range}")
        }
        ("piko.calendar", "delete_event_batch") => {
            let batch = calendar_delete_batch_input_from_value(&call.arguments)?;
            let mut lines = vec![format!("批量删除 {} 条日程：", batch.events.len())];
            for input in batch.events {
                let title = input.title.unwrap_or_else(|| format!("ID {}", input.id));
                let range = match (
                    format_tool_timestamp(input.start_at),
                    format_tool_timestamp(input.end_at),
                ) {
                    (Some(start), Some(end)) => format!("，{start} - {end}"),
                    _ => String::new(),
                };
                lines.push(format!("• {title}{range}"));
            }
            lines.join("\n")
        }
        ("piko.calendar", "create_event_batch") => {
            let batch = calendar_event_batch_input_from_value(&call.arguments)?;
            let mut lines = vec![format!("批量创建 {} 条日程：", batch.events.len())];
            for input in batch.events {
                let formatted_start = Local
                    .timestamp_opt(input.start_at as i64, 0)
                    .single()
                    .ok_or_else(|| "日程开始时间无效".to_string())?
                    .format("%Y-%m-%d %H:%M")
                    .to_string();
                let formatted_end = Local
                    .timestamp_opt(input.end_at as i64, 0)
                    .single()
                    .ok_or_else(|| "日程结束时间无效".to_string())?
                    .format("%H:%M")
                    .to_string();
                lines.push(format!(
                    "• {}：{formatted_start} - {formatted_end}",
                    input.title
                ));
            }
            lines.join("\n")
        }
        _ => return Err("该工具暂不支持确认后执行".to_string()),
    };
    Ok(ActionDraft {
        id: action_draft_id(),
        plugin_id: call.plugin_id.clone(),
        tool_name: call.tool_name.clone(),
        summary,
        arguments: call.arguments.clone(),
        created_at: now.timestamp().max(0) as u64,
    })
}

fn today_focus_minutes(records: &[FocusRecord], now: u64) -> u64 {
    let today = now / 86_400;
    records
        .iter()
        .filter(|record| record.completed_at / 86_400 == today)
        .map(|record| record.minutes)
        .sum()
}

fn read_settings(app: &AppHandle) -> AppSettings {
    let mut settings: AppSettings = app_settings_path(app)
        .map(|path| storage::read_or_default(&path))
        .unwrap_or_default();
    settings.has_api_key = read_api_key().is_some();
    settings
}

fn persist_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = app_settings_path(app).ok_or("无法获取设置路径")?;
    storage::write(&path, settings)
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|error| error.to_string())
}

fn read_api_key() -> Option<String> {
    keyring_entry().ok()?.get_password().ok()
}

fn update_api_key(api_key: Option<String>) -> Result<(), String> {
    let Some(api_key) = api_key else {
        return Ok(());
    };
    let entry = keyring_entry()?;

    if api_key.trim().is_empty() {
        let _ = entry.delete_credential();
    } else {
        entry
            .set_password(api_key.trim())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn normalize_base_url(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_string()
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum ProviderKind {
    OpenAiCompatible,
    Anthropic,
    Gemini,
}

fn provider_kind(provider: &str) -> Option<ProviderKind> {
    match provider {
        "openai-compatible" | "deepseek" | "dashscope" | "lmstudio" => {
            Some(ProviderKind::OpenAiCompatible)
        }
        "anthropic" => Some(ProviderKind::Anthropic),
        "gemini" => Some(ProviderKind::Gemini),
        _ => None,
    }
}

fn is_local_provider(provider: &str) -> bool {
    matches!(provider, "lmstudio" | "openai-compatible")
}

fn validate_ai_settings(settings: &AiSettings) -> Result<(), String> {
    if provider_kind(&settings.provider).is_none() {
        return Err("不支持的模型服务类型".to_string());
    }
    if !(settings.base_url.starts_with("http://") || settings.base_url.starts_with("https://")) {
        return Err("Base URL 必须以 http:// 或 https:// 开头".to_string());
    }
    if settings.model.trim().is_empty() && !is_local_provider(&settings.provider) {
        return Err("模型名称不能为空".to_string());
    }
    if settings.speech_model.trim().is_empty() {
        return Err("语音识别模型名称不能为空".to_string());
    }
    if !(0.0..=2.0).contains(&settings.temperature) {
        return Err("Temperature 必须在 0 到 2 之间".to_string());
    }
    if !(5..=600).contains(&settings.timeout_seconds) {
        return Err("超时时间必须在 5 到 600 秒之间".to_string());
    }
    Ok(())
}

fn should_bypass_system_proxy(base_url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(base_url) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_matches(['[', ']']);

    host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host == "::1"
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn http_client(settings: &AiSettings) -> Result<reqwest::Client, String> {
    let mut builder =
        reqwest::Client::builder().timeout(Duration::from_secs(settings.timeout_seconds));
    if should_bypass_system_proxy(&settings.base_url) {
        builder = builder.no_proxy();
    }
    builder.build().map_err(|error| error.to_string())
}

fn request_builder(
    client: &reqwest::Client,
    settings: &AiSettings,
    method: reqwest::Method,
    mut url: String,
) -> reqwest::RequestBuilder {
    let Some(api_key) = read_api_key() else {
        return client.request(method, url);
    };
    if provider_kind(&settings.provider) == Some(ProviderKind::Gemini) {
        if let Ok(mut parsed) = reqwest::Url::parse(&url) {
            parsed.query_pairs_mut().append_pair("key", &api_key);
            url = parsed.to_string();
        }
    }
    let builder = client.request(method, url);
    match provider_kind(&settings.provider) {
        Some(ProviderKind::Anthropic) => builder
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01"),
        Some(ProviderKind::Gemini) => builder,
        _ => builder.bearer_auth(api_key),
    }
}

fn models_url(settings: &AiSettings) -> String {
    format!("{}/models", normalize_base_url(&settings.base_url))
}

fn chat_url(settings: &AiSettings) -> Result<String, String> {
    let base_url = normalize_base_url(&settings.base_url);
    match provider_kind(&settings.provider) {
        Some(ProviderKind::OpenAiCompatible) => Ok(format!("{base_url}/chat/completions")),
        Some(ProviderKind::Anthropic) => Ok(format!("{base_url}/messages")),
        Some(ProviderKind::Gemini) => Ok(format!(
            "{base_url}/models/{}:streamGenerateContent?alt=sse",
            settings.model.trim_start_matches("models/")
        )),
        None => Err("不支持的模型服务类型".to_string()),
    }
}

fn speech_models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("speech-models"))
        .map_err(|error| format!("无法访问应用数据目录：{error}"))
}

fn speech_model_path(
    app: &AppHandle,
    definition: &SpeechModelDefinition,
) -> Result<PathBuf, String> {
    Ok(speech_models_dir(app)?
        .join(definition.archive_dir)
        .join(definition.file_name))
}

fn sense_voice_tokens_path(
    app: &AppHandle,
    definition: &SpeechModelDefinition,
) -> Result<PathBuf, String> {
    Ok(speech_models_dir(app)?
        .join(definition.archive_dir)
        .join("tokens.txt"))
}

fn speech_model_status(app: &AppHandle, definition: &SpeechModelDefinition) -> SpeechModelStatus {
    let path = speech_model_path(app, definition).ok();
    let byte_size = path
        .as_ref()
        .and_then(|path| fs::metadata(path).ok())
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let downloaded = byte_size > 0
        && sense_voice_tokens_path(app, definition)
            .map(|p| p.exists())
            .unwrap_or(false);
    SpeechModelStatus {
        id: definition.id.to_string(),
        name: definition.name.to_string(),
        file_name: definition.file_name.to_string(),
        download_url: definition.download_url.to_string(),
        downloaded,
        byte_size,
        path: path.map(|path| path.to_string_lossy().to_string()),
    }
}

fn read_le_u16(bytes: &[u8], offset: usize) -> Result<u16, String> {
    let chunk = bytes
        .get(offset..offset + 2)
        .ok_or_else(|| "WAV 数据不完整".to_string())?;
    Ok(u16::from_le_bytes([chunk[0], chunk[1]]))
}

fn read_le_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let chunk = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| "WAV 数据不完整".to_string())?;
    Ok(u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
}

fn decode_wav_pcm16_mono(bytes: &[u8]) -> Result<(u32, Vec<f32>), String> {
    if bytes.len() < 44 || bytes.get(0..4) != Some(b"RIFF") || bytes.get(8..12) != Some(b"WAVE") {
        return Err("录音必须是 WAV 格式。".to_string());
    }

    let mut offset = 12usize;
    let mut channels = 0u16;
    let mut sample_rate = 0u32;
    let mut bits_per_sample = 0u16;
    let mut audio_format = 0u16;
    let mut data_start = 0usize;
    let mut data_len = 0usize;

    while offset + 8 <= bytes.len() {
        let chunk_id = &bytes[offset..offset + 4];
        let chunk_size = read_le_u32(bytes, offset + 4)? as usize;
        let chunk_start = offset + 8;
        let chunk_end = chunk_start.saturating_add(chunk_size);
        if chunk_end > bytes.len() {
            return Err("WAV chunk 数据不完整。".to_string());
        }
        if chunk_id == b"fmt " {
            audio_format = read_le_u16(bytes, chunk_start)?;
            channels = read_le_u16(bytes, chunk_start + 2)?;
            sample_rate = read_le_u32(bytes, chunk_start + 4)?;
            bits_per_sample = read_le_u16(bytes, chunk_start + 14)?;
        } else if chunk_id == b"data" {
            data_start = chunk_start;
            data_len = chunk_size;
        }
        offset = chunk_end + (chunk_size % 2);
    }

    if audio_format != 1 || bits_per_sample != 16 {
        return Err("当前内置 Whisper 只支持 PCM16 WAV 录音。".to_string());
    }
    if channels == 0 || channels > 2 {
        return Err("当前只支持单声道或双声道录音。".to_string());
    }
    if sample_rate == 0 || data_len == 0 {
        return Err("WAV 录音没有有效音频数据。".to_string());
    }

    let frame_count = data_len / (usize::from(channels) * 2);
    let mut samples = Vec::with_capacity(frame_count);
    for frame in 0..frame_count {
        let mut value = 0.0f32;
        for channel in 0..usize::from(channels) {
            let sample_offset = data_start + (frame * usize::from(channels) + channel) * 2;
            let chunk = bytes
                .get(sample_offset..sample_offset + 2)
                .ok_or_else(|| "WAV 采样数据不完整。".to_string())?;
            value += i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / i16::MAX as f32;
        }
        samples.push(value / f32::from(channels));
    }
    Ok((sample_rate, samples))
}

fn resample_to_16khz(sample_rate: u32, samples: &[f32]) -> Vec<f32> {
    const TARGET_SAMPLE_RATE: u32 = 16_000;
    if sample_rate == TARGET_SAMPLE_RATE || samples.is_empty() {
        return samples.to_vec();
    }
    let ratio = sample_rate as f64 / TARGET_SAMPLE_RATE as f64;
    let output_len = (samples.len() as f64 / ratio).ceil() as usize;
    let mut output = Vec::with_capacity(output_len);
    for index in 0..output_len {
        let source = index as f64 * ratio;
        let left = source.floor() as usize;
        let right = (left + 1).min(samples.len().saturating_sub(1));
        let fraction = (source - left as f64) as f32;
        output.push(samples[left] * (1.0 - fraction) + samples[right] * fraction);
    }
    output
}

fn transcribe_with_sense_voice(
    model_path: PathBuf,
    tokens_path: PathBuf,
    audio: Vec<f32>,
    sample_rate: i32,
) -> Result<String, String> {
    use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, OfflineSenseVoiceModelConfig};

    let mut config = OfflineRecognizerConfig::default();
    config.model_config.sense_voice = OfflineSenseVoiceModelConfig {
        model: Some(model_path.to_string_lossy().into_owned()),
        language: Some("zh".to_string()),
        use_itn: true,
    };
    config.model_config.tokens = Some(tokens_path.to_string_lossy().into_owned());
    config.model_config.provider = Some("cpu".to_string());
    config.model_config.num_threads = 2;

    let recognizer = OfflineRecognizer::create(&config)
        .ok_or_else(|| "加载 SenseVoice 模型失败：无法创建识别器".to_string())?;
    let stream = recognizer.create_stream();
    stream.accept_waveform(sample_rate, &audio);
    recognizer.decode(&stream);
    let text = stream
        .get_result()
        .map(|result| result.text.trim().to_string())
        .unwrap_or_default();
    Ok(text)
}

fn parse_data_url(data_url: &str) -> Result<(&str, &str), String> {
    let encoded = data_url
        .strip_prefix("data:")
        .and_then(|value| value.split_once(";base64,"))
        .ok_or_else(|| "截图数据格式无效".to_string())?;
    Ok(encoded)
}

fn persist_pet_position(app: &AppHandle, position: PhysicalPosition<i32>) {
    let Some(path) = pet_position_path(app) else {
        return;
    };
    let Some(directory) = path.parent() else {
        return;
    };
    let Ok(json) = serde_json::to_string(&PetPosition {
        x: position.x,
        y: position.y,
    }) else {
        return;
    };

    let _ = fs::create_dir_all(directory);
    let _ = fs::write(path, json);
}

fn persist_bubble_size(app: &AppHandle, size: PhysicalSize<u32>) {
    let Some(path) = bubble_size_path(app) else {
        return;
    };
    let Some(directory) = path.parent() else {
        return;
    };
    let Ok(json) = serde_json::to_string(&BubbleSize {
        width: size.width,
        height: size.height,
    }) else {
        return;
    };

    let _ = fs::create_dir_all(directory);
    let _ = fs::write(path, json);
}

fn monitor_contains(
    monitor_position: PhysicalPosition<i32>,
    monitor_size: tauri::PhysicalSize<u32>,
    position: PhysicalPosition<i32>,
) -> bool {
    position.x >= monitor_position.x
        && position.y >= monitor_position.y
        && position.x < monitor_position.x + monitor_size.width as i32
        && position.y < monitor_position.y + monitor_size.height as i32
}

fn clamp_pet_physical_position(
    requested: PhysicalPosition<i32>,
    window_size: PhysicalSize<u32>,
    work_area_position: PhysicalPosition<i32>,
    work_area_size: PhysicalSize<u32>,
    peek: i32,
) -> PhysicalPosition<i32> {
    let x = requested
        .x
        .max(work_area_position.x - window_size.width as i32 + peek)
        .min(work_area_position.x + work_area_size.width as i32 - peek);
    let y = requested
        .y
        .max(work_area_position.y - window_size.height as i32 + peek)
        .min(work_area_position.y + work_area_size.height as i32 - peek);
    PhysicalPosition::new(x, y)
}

fn restore_pet_position(app: &AppHandle) {
    let Some(window) = app.get_webview_window("pet") else {
        return;
    };
    let Some(path) = pet_position_path(app) else {
        return;
    };
    let Ok(json) = fs::read_to_string(path) else {
        return;
    };
    let Ok(saved) = serde_json::from_str::<PetPosition>(&json) else {
        return;
    };
    let position = PhysicalPosition::new(saved.x, saved.y);
    let Ok(monitors) = window.available_monitors() else {
        return;
    };
    let Ok(window_size) = window.outer_size() else {
        return;
    };
    let peek = window
        .scale_factor()
        .map(|scale| (PET_PEEK as f64 * scale).round() as i32)
        .unwrap_or(PET_PEEK)
        .max(1);
    let Some(monitor) = monitors
        .iter()
        .find(|monitor| monitor_contains(*monitor.position(), *monitor.size(), position))
        .or_else(|| monitors.first())
    else {
        return;
    };
    let work_area = monitor.work_area();
    let clamped = clamp_pet_physical_position(
        position,
        window_size,
        work_area.position,
        work_area.size,
        peek,
    );
    let _ = window.set_position(clamped);
}

fn show_pet_on_startup(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("pet") {
        let _ = window.unminimize();
        let _ = window.show();
    }
}

fn save_current_pet_position(app: &AppHandle) {
    let Some(window) = app.get_webview_window("pet") else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    persist_pet_position(app, position);
}

fn restore_bubble_size(app: &AppHandle) {
    let Some(window) = app.get_webview_window("bubble") else {
        return;
    };
    let Some(path) = bubble_size_path(app) else {
        return;
    };
    let Ok(json) = fs::read_to_string(path) else {
        return;
    };
    let Ok(saved) = serde_json::from_str::<BubbleSize>(&json) else {
        return;
    };
    let size = PhysicalSize::new(saved.width, saved.height);
    let _ = window.set_size(size);
}

fn save_current_bubble_size(app: &AppHandle) {
    let Some(window) = app.get_webview_window("bubble") else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    persist_bubble_size(app, size);
}

fn clamp_pet_position(
    requested: LogicalPosition<f64>,
    window_size: LogicalSize<f64>,
    work_area_position: LogicalPosition<f64>,
    work_area_size: LogicalSize<f64>,
) -> LogicalPosition<f64> {
    let peek = PET_PEEK as f64;
    let x = requested
        .x
        .max(work_area_position.x - window_size.width + peek)
        .min(work_area_position.x + work_area_size.width - peek);
    let y = requested
        .y
        .max(work_area_position.y - window_size.height + peek)
        .min(work_area_position.y + work_area_size.height - peek);
    LogicalPosition::new(x, y)
}

#[tauri::command]
fn move_pet(app: AppHandle, x: f64, y: f64) -> Result<(f64, f64), String> {
    let window = app
        .get_webview_window("pet")
        .ok_or_else(|| "pet window not found".to_string())?;
    let requested = LogicalPosition::new(x.round(), y.round());
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let scale_factor = window.scale_factor().map_err(|e| e.to_string())?;
    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    let Some(monitor) = monitors
        .iter()
        .find(|monitor| {
            let area = monitor.work_area();
            let position = area.position.to_logical::<f64>(scale_factor);
            let size = area.size.to_logical::<f64>(scale_factor);
            requested.x >= position.x
                && requested.y >= position.y
                && requested.x < position.x + size.width
                && requested.y < position.y + size.height
        })
        .or_else(|| monitors.first())
    else {
        window.set_position(requested).map_err(|e| e.to_string())?;
        return Ok((requested.x, requested.y));
    };
    let area = monitor.work_area();
    let position = clamp_pet_position(
        requested,
        size.to_logical::<f64>(scale_factor),
        area.position.to_logical::<f64>(scale_factor),
        area.size.to_logical::<f64>(scale_factor),
    );
    window.set_position(position).map_err(|e| e.to_string())?;
    Ok((position.x, position.y))
}

#[tauri::command]
fn move_pet_relative(app: AppHandle, dx: f64, dy: f64) -> Result<(f64, f64), String> {
    let window = app
        .get_webview_window("pet")
        .ok_or_else(|| "pet window not found".to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let scale_factor = window.scale_factor().map_err(|e| e.to_string())?;
    let logical_pos: LogicalPosition<f64> = pos.to_logical::<f64>(scale_factor);
    move_pet(app, logical_pos.x + dx, logical_pos.y + dy)
}

#[tauri::command]
fn get_pet_position(app: AppHandle) -> Result<(f64, f64), String> {
    let window = app
        .get_webview_window("pet")
        .ok_or("pet window not found")?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let scale_factor = window.scale_factor().map_err(|e| e.to_string())?;
    let logical_pos: LogicalPosition<f64> = pos.to_logical::<f64>(scale_factor);
    Ok((logical_pos.x, logical_pos.y))
}

fn place_bubble_near_pet(app: &AppHandle) {
    let Some(pet) = app.get_webview_window("pet") else {
        return;
    };
    let Some(bubble) = app.get_webview_window("bubble") else {
        return;
    };
    let (Ok(pet_position), Ok(pet_size), Ok(bubble_size), Ok(Some(monitor))) = (
        pet.outer_position(),
        pet.outer_size(),
        bubble.outer_size(),
        pet.current_monitor(),
    ) else {
        return;
    };

    let area = monitor.work_area();
    let left = area.position.x + PET_MARGIN;
    let right = area.position.x + area.size.width as i32 - bubble_size.width as i32 - PET_MARGIN;
    let top = area.position.y + PET_MARGIN;
    let bottom = area.position.y + area.size.height as i32 - bubble_size.height as i32 - PET_MARGIN;
    let preferred_x = pet_position.x + pet_size.width as i32 - bubble_size.width as i32;
    let preferred_y = pet_position.y - bubble_size.height as i32 - 8;
    let fallback_y = pet_position.y + pet_size.height as i32 + 8;
    let y = if preferred_y >= top {
        preferred_y
    } else {
        fallback_y
    };

    let _ = bubble.set_position(PhysicalPosition::new(
        preferred_x.clamp(left, right.max(left)),
        y.clamp(top, bottom.max(top)),
    ));
}

fn watch_pet_position(app: &AppHandle) {
    let Some(window) = app.get_webview_window("pet") else {
        return;
    };
    let app = app.clone();
    let debounce =
        debounce::Debouncer::new(Duration::from_millis(PET_MOVE_DEBOUNCE_MS), move || {
            save_current_pet_position(&app)
        });
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Moved(_)) {
            debounce.trigger();
        }
    });
}

fn watch_bubble_resize(app: &AppHandle) {
    let Some(window) = app.get_webview_window("bubble") else {
        return;
    };
    let app = app.clone();
    let debounce =
        debounce::Debouncer::new(Duration::from_millis(PET_MOVE_DEBOUNCE_MS), move || {
            save_current_bubble_size(&app)
        });
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Resized(_)) {
            debounce.trigger();
        }
    });
}

fn watch_panel_close(app: &AppHandle) {
    let Some(panel) = app.get_webview_window("panel") else {
        return;
    };
    let app = app.clone();

    panel.on_window_event(move |event| {
        let WindowEvent::CloseRequested { api, .. } = event else {
            return;
        };
        api.prevent_close();
        if let Some(panel) = app.get_webview_window("panel") {
            let _ = panel.hide();
        }
        let pet_is_visible = app
            .get_webview_window("pet")
            .and_then(|pet| pet.is_visible().ok())
            .unwrap_or(false);
        if !pet_is_visible {
            show_and_focus(&app, "pet");
        }
    });
}

#[cfg(target_os = "macos")]
fn enable_pet_background_drag(app: &AppHandle) {
    let Some(window) = app.get_webview_window("pet") else {
        return;
    };

    let _ = window.with_webview(|webview| unsafe {
        let ns_window: &objc2_app_kit::NSWindow = &*webview.ns_window().cast();
        ns_window.setMovableByWindowBackground(false);
    });
}

#[cfg(not(target_os = "macos"))]
fn enable_pet_background_drag(_app: &AppHandle) {}

#[cfg(target_os = "macos")]
fn enable_bubble_background_drag(_app: &AppHandle) {}

#[cfg(not(target_os = "macos"))]
fn enable_bubble_background_drag(_app: &AppHandle) {}

fn show_and_focus(app: &AppHandle, label: &str) {
    if label == "bubble" {
        place_bubble_near_pet(app);
    }
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn focus_pet_after_bubble_show(app: &AppHandle) {
    if let Some(pet_window) = app.get_webview_window("pet") {
        let _ = pet_window.set_focus();
    }

    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(40));
        if let Some(pet_window) = app.get_webview_window("pet") {
            let _ = pet_window.set_focus();
        }
    });
}

#[tauri::command]
fn show_bubble(app: AppHandle) {
    show_and_focus(&app, "bubble");
}

#[tauri::command]
fn hide_bubble(app: AppHandle) {
    if let Some(window) = app.get_webview_window("bubble") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn toggle_bubble(app: AppHandle) {
    if let Some(window) = app.get_webview_window("bubble") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            // 显示气泡但不抢焦点，保持宠物窗口为焦点窗口
            // 这样再次点击宠物时可以立即触发切换，不需要先激活窗口
            place_bubble_near_pet(&app);
            let _ = window.unminimize();
            let _ = window.show();
            focus_pet_after_bubble_show(&app);
        }
    }
}

#[tauri::command]
fn open_panel(app: AppHandle) {
    show_and_focus(&app, "panel");
}

#[tauri::command]
fn toggle_panel(app: AppHandle) {
    if let Some(window) = app.get_webview_window("panel") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_and_focus(&app, "panel");
        }
    }
}

#[tauri::command]
fn show_pet(app: AppHandle) {
    show_and_focus(&app, "pet");
}

#[tauri::command]
fn hide_pet(app: AppHandle) {
    if let Some(window) = app.get_webview_window("pet") {
        let _ = window.hide();
    }
}

#[cfg(target_os = "macos")]
fn ensure_screen_capture_permission() -> Result<(), String> {
    let access = core_graphics::access::ScreenCaptureAccess;
    if access.preflight() || access.request() {
        Ok(())
    } else {
        Err(
            "Piko 没有屏幕录制权限。请在“系统设置 → 隐私与安全性 → 屏幕录制”中允许 Piko，然后重新启动应用。"
                .to_string(),
        )
    }
}

#[cfg(not(target_os = "macos"))]
fn ensure_screen_capture_permission() -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn capture_area_coordinates(
    origin: PhysicalPosition<i32>,
    selection: &CaptureSelection,
    _scale: f64,
) -> (i32, i32, u32, u32) {
    (
        origin.x + selection.x.round() as i32,
        origin.y + selection.y.round() as i32,
        selection.width.round() as u32,
        selection.height.round() as u32,
    )
}

#[cfg(not(target_os = "macos"))]
fn capture_area_coordinates(
    origin: PhysicalPosition<i32>,
    selection: &CaptureSelection,
    scale: f64,
) -> (i32, i32, u32, u32) {
    (
        origin.x + (selection.x * scale).round() as i32,
        origin.y + (selection.y * scale).round() as i32,
        (selection.width * scale).round() as u32,
        (selection.height * scale).round() as u32,
    )
}

#[tauri::command]
fn begin_screen_capture(app: AppHandle) -> Result<(), String> {
    ensure_screen_capture_permission()?;
    let capture = app
        .get_webview_window("capture")
        .ok_or_else(|| "无法打开截图选择窗口".to_string())?;
    let reference = app
        .get_webview_window("pet")
        .and_then(|window| window.current_monitor().ok().flatten())
        .or_else(|| capture.primary_monitor().ok().flatten())
        .ok_or_else(|| "无法识别当前显示器".to_string())?;

    capture
        .set_position(*reference.position())
        .map_err(|error| error.to_string())?;
    capture
        .set_size(*reference.size())
        .map_err(|error| error.to_string())?;
    capture.show().map_err(|error| error.to_string())?;
    capture.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
fn cancel_screen_capture(app: AppHandle) {
    if let Some(window) = app.get_webview_window("capture") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn confirm_screen_capture(
    app: AppHandle,
    captures: State<'_, ScreenCaptureStore>,
    selection: CaptureSelection,
) -> Result<ScreenshotPreview, String> {
    if selection.width < 8.0 || selection.height < 8.0 {
        return Err("请框选一个更大的截图区域".to_string());
    }
    let capture = app
        .get_webview_window("capture")
        .ok_or_else(|| "无法读取截图选择窗口".to_string())?;
    let origin = capture
        .outer_position()
        .map_err(|error| error.to_string())?;
    let scale = capture.scale_factor().map_err(|error| error.to_string())?;
    let (x, y, width, height) = capture_area_coordinates(origin, &selection, scale);
    let _ = capture.hide();
    thread::sleep(Duration::from_millis(140));

    let png = (|| {
        let screen = Screen::from_point(x, y).map_err(|error| format!("无法读取屏幕：{error}"))?;
        let image = screen
            .capture_area(
                x - screen.display_info.x,
                y - screen.display_info.y,
                width,
                height,
            )
            .map_err(|error| format!("截图失败，请检查屏幕录制权限：{error}"))?;
        let mut png = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut png, screenshots::image::ImageOutputFormat::Png)
            .map_err(|error| format!("无法生成截图预览：{error}"))?;
        Ok::<_, String>(png.into_inner())
    })();
    let png = match png {
        Ok(png) => png,
        Err(error) => {
            let _ = capture.show();
            let _ = capture.set_focus();
            return Err(error);
        }
    };
    let data_url = format!("data:image/png;base64,{}", BASE64_STANDARD.encode(png));
    let preview = ScreenshotPreview {
        data_url: data_url.clone(),
        width,
        height,
    };
    *captures
        .0
        .lock()
        .map_err(|_| "无法保存截图状态".to_string())? = Some(ScreenCapture {
        data_url,
        width,
        height,
    });
    show_and_focus(&app, "bubble");
    let _ = app.emit_to("bubble", "screenshot-ready", preview.clone());
    Ok(preview)
}

#[tauri::command]
fn get_screen_capture_preview(
    captures: State<'_, ScreenCaptureStore>,
) -> Result<Option<ScreenshotPreview>, String> {
    Ok(captures
        .0
        .lock()
        .map_err(|_| "无法读取截图状态".to_string())?
        .as_ref()
        .map(|capture| ScreenshotPreview {
            data_url: capture.data_url.clone(),
            width: capture.width,
            height: capture.height,
        }))
}

#[tauri::command]
fn clear_screen_capture(captures: State<'_, ScreenCaptureStore>) -> Result<(), String> {
    *captures
        .0
        .lock()
        .map_err(|_| "无法清除截图状态".to_string())? = None;
    Ok(())
}

#[tauri::command]
fn get_settings(app: AppHandle) -> AppSettings {
    read_settings(&app)
}

#[tauri::command]
fn screen_capture_permission_status() -> String {
    #[cfg(target_os = "macos")]
    {
        let access = core_graphics::access::ScreenCaptureAccess;
        if access.preflight() {
            "已授权".to_string()
        } else {
            "截图时按需申请，首次使用请允许屏幕录制".to_string()
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        "截图时按需读取".to_string()
    }
}

fn version_parts(version: &str) -> Vec<u64> {
    version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .map(|part| part.parse().unwrap_or(0))
        .collect()
}

#[tauri::command]
async fn check_for_updates() -> Result<UpdateInfo, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let response = reqwest::Client::new()
        .get("https://api.github.com/repos/Martinsuper/im-robot/releases/latest")
        .header(reqwest::header::USER_AGENT, "Piko-Desktop-Companion")
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;
    let latest_version = response["tag_name"]
        .as_str()
        .ok_or_else(|| "发布源没有返回版本号".to_string())?
        .trim_start_matches('v')
        .to_string();
    let release_url = response["html_url"]
        .as_str()
        .unwrap_or("https://github.com/Martinsuper/im-robot/releases")
        .to_string();
    Ok(UpdateInfo {
        available: version_parts(&latest_version) > version_parts(&current_version),
        current_version,
        latest_version,
        release_url,
    })
}

#[tauri::command]
fn list_chat_history(app: AppHandle) -> Vec<ChatHistoryEntry> {
    read_chat_history(&app)
}

#[tauri::command]
fn clear_chat_history(app: AppHandle, context: State<'_, ChatContext>) -> Result<(), String> {
    let _transaction = storage::transaction();
    context
        .0
        .lock()
        .map_err(|_| "无法清除当前对话上下文".to_string())?
        .clear();
    persist_chat_history(&app, &[])?;
    let _ = app.emit_to("panel", "chat-history-updated", ());
    Ok(())
}

#[tauri::command]
fn clear_chat_context(context: State<'_, ChatContext>) -> Result<(), String> {
    context
        .0
        .lock()
        .map_err(|_| "无法清除当前对话上下文".to_string())?
        .clear();
    Ok(())
}

#[tauri::command]
fn get_bubble_chat_history(
    context: State<'_, ChatContext>,
) -> Result<Vec<ChatHistoryEntry>, String> {
    let mut entries = context
        .0
        .lock()
        .map_err(|_| "无法读取对话历史".to_string())?
        .clone();
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.created_at));
    entries.truncate(20);
    Ok(entries)
}

fn stop_local_tts(tts: &LocalTts) -> Result<(), String> {
    let mut active = tts
        .0
        .lock()
        .map_err(|_| "无法读取本地朗读状态".to_string())?;
    if let Some(mut child) = active.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

fn is_emoji_component(character: char) -> bool {
    matches!(
        character as u32,
        0x1F1E6..=0x1F1FF
            | 0x1F300..=0x1FAFF
            | 0x2300..=0x23FF
            | 0x2600..=0x27BF
            | 0x2B00..=0x2BFF
            | 0xFE0E..=0xFE0F
            | 0x200D
            | 0x20E3
    )
}

fn text_for_speech(text: &str) -> String {
    text.chars()
        .filter(|character| !is_emoji_component(*character))
        .collect::<String>()
}

fn spawn_local_tts(text: &str) -> Result<Child, String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("say")
            .arg("--")
            .arg(text)
            .spawn()
            .map_err(|error| format!("无法启动 macOS 本地朗读：{error}"))
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Add-Type -AssemblyName System.Speech; $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer; $speaker.Speak($env:PIKO_TTS_TEXT)",
            ])
            .env("PIKO_TTS_TEXT", text)
            .spawn()
            .map_err(|error| format!("无法启动 Windows 本地朗读：{error}"))
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("spd-say")
            .arg("--")
            .arg(text)
            .spawn()
            .map_err(|error| format!("无法启动 Linux 本地朗读，请安装 speech-dispatcher：{error}"))
    }
}

#[tauri::command]
fn speak_local_text(tts: State<'_, LocalTts>, text: String) -> Result<(), String> {
    let text = text_for_speech(&text);
    let text = text.trim();
    if text.is_empty() {
        return Err("没有可朗读的内容".to_string());
    }
    stop_local_tts(&tts)?;
    let child = spawn_local_tts(text)?;
    *tts.0
        .lock()
        .map_err(|_| "无法更新本地朗读状态".to_string())? = Some(child);
    Ok(())
}

#[tauri::command]
fn stop_local_speech(tts: State<'_, LocalTts>) -> Result<(), String> {
    stop_local_tts(&tts)
}

#[tauri::command]
fn list_reminders(app: AppHandle) -> Vec<Reminder> {
    let mut reminders = read_reminders(&app);
    reminders.sort_by_key(|reminder| reminder.due_at);
    reminders
}

fn truncate_text(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn memo_category_label(category: &str) -> &'static str {
    match category {
        "task" => "任务",
        "idea" => "想法",
        "learning" => "学习",
        "work" => "工作",
        "life" => "生活",
        "reference" => "资料",
        _ => "其他",
    }
}

fn infer_memo_category(title: &str, content: &str) -> String {
    let text = format!("{title}\n{content}").to_lowercase();
    let rules = [
        (
            "task",
            [
                "todo", "待办", "任务", "完成", "处理", "跟进", "提交", "检查", "修复", "提醒",
                "截止",
            ]
            .as_slice(),
        ),
        (
            "idea",
            [
                "想法", "灵感", "可以", "也许", "方案", "创意", "idea", "假设",
            ]
            .as_slice(),
        ),
        (
            "learning",
            [
                "学习", "笔记", "知识", "课程", "阅读", "概念", "总结", "复盘", "learn",
            ]
            .as_slice(),
        ),
        (
            "work",
            [
                "工作", "项目", "会议", "需求", "评审", "客户", "版本", "发布", "prd",
            ]
            .as_slice(),
        ),
        (
            "life",
            [
                "生活", "购物", "买", "家里", "旅行", "运动", "健康", "吃", "家庭",
            ]
            .as_slice(),
        ),
        (
            "reference",
            [
                "链接", "资料", "参考", "文档", "地址", "url", "http", "配置", "账号",
            ]
            .as_slice(),
        ),
    ];

    rules
        .iter()
        .find(|(_, keywords)| keywords.iter().any(|keyword| text.contains(keyword)))
        .map(|(category, _)| (*category).to_string())
        .unwrap_or_else(|| "other".to_string())
}

fn summarize_memo(title: &str, content: &str) -> String {
    let content = content.replace('\n', " ");
    let normalized = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        truncate_text(title, 80)
    } else if normalized.chars().count() <= 96 {
        normalized
    } else {
        format!("{}...", truncate_text(&normalized, 96))
    }
}

fn infer_memo_tags(category: &str, title: &str, content: &str) -> Vec<String> {
    let text = format!("{title}\n{content}").to_lowercase();
    let mut tags = vec![memo_category_label(category).to_string()];
    for (tag, keywords) in [
        ("紧急", ["紧急", "马上", "今天", "尽快", "asap"].as_slice()),
        ("会议", ["会议", "meeting", "评审", "同步"].as_slice()),
        ("代码", ["代码", "bug", "修复", "接口", "api"].as_slice()),
        ("资料", ["链接", "文档", "参考", "http", "资料"].as_slice()),
        ("计划", ["计划", "安排", "路线", "步骤"].as_slice()),
    ] {
        if keywords.iter().any(|keyword| text.contains(keyword)) {
            tags.push(tag.to_string());
        }
    }
    tags.sort();
    tags.dedup();
    tags.truncate(4);
    tags
}

fn memo_from_input(id: String, input: MemoInput, created_at: u64) -> Result<Memo, String> {
    let title = input.title.trim();
    let content = input.content.trim();
    if title.is_empty() {
        return Err("备忘录标题不能为空".to_string());
    }
    if title.chars().count() > 120 {
        return Err("备忘录标题不能超过 120 个字符".to_string());
    }
    if content.is_empty() {
        return Err("备忘录内容不能为空".to_string());
    }
    if content.chars().count() > 8000 {
        return Err("备忘录内容不能超过 8000 个字符".to_string());
    }

    let category = infer_memo_category(title, content);
    let now = unix_timestamp();
    Ok(Memo {
        id,
        title: title.to_string(),
        content: content.to_string(),
        summary: summarize_memo(title, content),
        tags: infer_memo_tags(&category, title, content),
        category,
        created_at,
        updated_at: now,
    })
}

#[tauri::command]
fn list_memos(app: AppHandle) -> Vec<Memo> {
    let mut memos = read_memos(&app);
    memos.sort_by_key(|memo| std::cmp::Reverse(memo.updated_at));
    memos
}

#[tauri::command]
fn create_memo(app: AppHandle, input: MemoInput) -> Result<Memo, String> {
    create_memo_record(&app, input)
}

fn create_memo_record(app: &AppHandle, input: MemoInput) -> Result<Memo, String> {
    let _transaction = storage::transaction();
    let now = unix_timestamp();
    let memo = memo_from_input(memo_id(), input, now)?;
    let mut memos = read_memos(app);
    memos.push(memo.clone());
    persist_memos(app, &memos)?;
    let _ = app.emit_to("panel", "memos-updated", ());
    Ok(memo)
}

#[tauri::command]
fn update_memo(app: AppHandle, id: String, input: MemoInput) -> Result<Memo, String> {
    let _transaction = storage::transaction();
    let mut memos = read_memos(&app);
    let index = memos
        .iter()
        .position(|memo| memo.id == id)
        .ok_or_else(|| "未找到该备忘录".to_string())?;
    let created_at = memos[index].created_at;
    let memo = memo_from_input(id, input, created_at)?;
    memos[index] = memo.clone();
    persist_memos(&app, &memos)?;
    let _ = app.emit_to("panel", "memos-updated", ());
    Ok(memo)
}

#[tauri::command]
fn delete_memo(app: AppHandle, id: String) -> Result<(), String> {
    let _transaction = storage::transaction();
    let mut memos = read_memos(&app);
    let previous_len = memos.len();
    memos.retain(|memo| memo.id != id);
    if memos.len() == previous_len {
        return Err("未找到该备忘录".to_string());
    }
    persist_memos(&app, &memos)?;
    let _ = app.emit_to("panel", "memos-updated", ());
    Ok(())
}

#[tauri::command]
fn summarize_memos(app: AppHandle) -> Vec<MemoSummaryGroup> {
    let memos = read_memos(&app);
    let order = [
        "task",
        "idea",
        "learning",
        "work",
        "life",
        "reference",
        "other",
    ];
    let mut groups = Vec::new();

    for category in order {
        let items = memos
            .iter()
            .filter(|memo| memo.category == category)
            .collect::<Vec<_>>();
        if items.is_empty() {
            continue;
        }

        let mut tag_counts: HashMap<String, usize> = HashMap::new();
        for memo in &items {
            for tag in &memo.tags {
                *tag_counts.entry(tag.clone()).or_default() += 1;
            }
        }
        let mut top_tags = tag_counts.into_iter().collect::<Vec<_>>();
        top_tags.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));

        let latest_updated_at = items
            .iter()
            .map(|memo| memo.updated_at)
            .max()
            .unwrap_or_default();
        let sample_titles = items
            .iter()
            .take(3)
            .map(|memo| memo.title.as_str())
            .collect::<Vec<_>>()
            .join("、");

        groups.push(MemoSummaryGroup {
            category: category.to_string(),
            count: items.len(),
            latest_updated_at,
            summary: format!(
                "{}类备忘共 {} 条：{}",
                memo_category_label(category),
                items.len(),
                sample_titles
            ),
            top_tags: top_tags.into_iter().take(4).map(|(tag, _)| tag).collect(),
        });
    }

    groups
}

fn create_reminder_record(app: &AppHandle, input: ReminderInput) -> Result<Reminder, String> {
    let _transaction = storage::transaction();
    let title = input.title.trim();
    if title.is_empty() {
        return Err("提醒内容不能为空".to_string());
    }
    if title.chars().count() > 120 {
        return Err("提醒内容不能超过 120 个字符".to_string());
    }
    if input.due_at <= unix_timestamp() {
        return Err("提醒时间必须晚于当前时间".to_string());
    }
    if !matches!(
        input.repeat.as_str(),
        "none" | "daily" | "weekly" | "weekdays"
    ) {
        return Err("不支持的重复提醒规则".to_string());
    }

    let reminder = Reminder {
        id: reminder_id(),
        title: title.to_string(),
        due_at: input.due_at,
        status: "pending".to_string(),
        repeat: input.repeat,
    };
    let mut reminders = read_reminders(app);
    reminders.push(reminder.clone());
    persist_reminders(app, &reminders)?;
    let _ = app.emit_to("panel", "reminders-updated", ());
    Ok(reminder)
}

fn delete_reminder_record(app: &AppHandle, input: ReminderDeleteInput) -> Result<Reminder, String> {
    let _transaction = storage::transaction();
    let mut reminders = read_reminders(app);
    let index = reminders
        .iter()
        .position(|reminder| reminder.id == input.id)
        .ok_or_else(|| "未找到该提醒".to_string())?;
    let deleted = reminders.remove(index);
    persist_reminders(app, &reminders)?;
    let _ = app.emit_to("panel", "reminders-updated", ());
    Ok(deleted)
}

#[tauri::command]
fn create_reminder(app: AppHandle, input: ReminderInput) -> Result<Reminder, String> {
    create_reminder_record(&app, input)
}

#[tauri::command]
fn list_calendar_events(app: AppHandle) -> Vec<CalendarEvent> {
    let mut events = read_calendar_events(&app);
    events.sort_by_key(|event| event.start_at);
    events
}

fn create_calendar_event_record(
    app: &AppHandle,
    input: CalendarEventInput,
) -> Result<CalendarEvent, String> {
    let path = calendar_events_path(app).ok_or_else(|| "无法获取日程记录路径".to_string())?;
    let event = create_calendar_event_record_at_path(&path, input)?;
    let _ = app.emit("calendar-events-updated", ());
    Ok(event)
}

fn create_calendar_event_record_at_path(
    path: &Path,
    input: CalendarEventInput,
) -> Result<CalendarEvent, String> {
    let _transaction = storage::transaction();
    let mut events = read_calendar_events_from_path(path);
    let event = calendar_event_from_input(input)?;
    events.push(event.clone());
    persist_calendar_events_to_path(path, &events)?;
    Ok(event)
}

fn delete_calendar_event_record(
    app: &AppHandle,
    input: CalendarDeleteInput,
) -> Result<CalendarEvent, String> {
    let _transaction = storage::transaction();
    let mut events = read_calendar_events(app);
    let index = events
        .iter()
        .position(|event| event.id == input.id)
        .ok_or_else(|| "未找到该日程".to_string())?;
    let deleted = events.remove(index);
    persist_calendar_events(app, &events)?;
    crate::sync::calendar_sync::mark_local_events_deleted(app, std::slice::from_ref(&deleted.id))?;
    let _ = app.emit("calendar-events-updated", ());
    Ok(deleted)
}

fn delete_calendar_event_batch_record(
    app: &AppHandle,
    input: CalendarDeleteBatchInput,
) -> Result<Vec<CalendarEvent>, String> {
    let path = calendar_events_path(app).ok_or_else(|| "无法获取日程记录路径".to_string())?;
    let deleted = delete_calendar_event_batch_record_at_path(&path, input)?;
    let deleted_ids = deleted
        .iter()
        .map(|event| event.id.clone())
        .collect::<Vec<_>>();
    crate::sync::calendar_sync::mark_local_events_deleted(app, &deleted_ids)?;
    let _ = app.emit("calendar-events-updated", ());
    Ok(deleted)
}

fn delete_calendar_event_batch_record_at_path(
    path: &Path,
    input: CalendarDeleteBatchInput,
) -> Result<Vec<CalendarEvent>, String> {
    let _transaction = storage::transaction();
    let mut ids = HashSet::new();
    for event in &input.events {
        if !ids.insert(event.id.as_str()) {
            return Err(format!("批量删除日程中包含重复 ID：{}", event.id));
        }
    }

    let mut events = read_calendar_events_from_path(path);
    let deleted = events
        .iter()
        .filter(|event| ids.contains(event.id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if deleted.len() != ids.len() {
        return Err("部分待删除日程已不存在，请重新查询日程后再试".to_string());
    }
    events.retain(|event| !ids.contains(event.id.as_str()));
    persist_calendar_events_to_path(path, &events)?;
    Ok(deleted)
}

fn calendar_conflict_note(
    existing_events: &[CalendarEvent],
    start_at: u64,
    end_at: u64,
) -> Option<String> {
    let conflicts = find_calendar_conflicts(existing_events, start_at, end_at);
    if conflicts.is_empty() {
        None
    } else {
        Some(format!(
            "提示：该时间段与已有 {} 条日程重叠，但已继续创建。",
            conflicts.len()
        ))
    }
}

fn calendar_event_from_input(input: CalendarEventInput) -> Result<CalendarEvent, String> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err("日程标题不能为空".to_string());
    }
    if title.chars().count() > 120 {
        return Err("日程标题不能超过 120 个字符".to_string());
    }
    if input.start_at <= unix_timestamp() {
        return Err("日程开始时间必须晚于当前时间".to_string());
    }
    if input.end_at <= input.start_at {
        return Err("日程结束时间必须晚于开始时间".to_string());
    }
    Ok(CalendarEvent {
        id: calendar_event_id(),
        title: title.to_string(),
        start_at: input.start_at,
        end_at: input.end_at,
        location: input.location.filter(|value| !value.trim().is_empty()),
        notes: input.notes.filter(|value| !value.trim().is_empty()),
    })
}

fn create_calendar_event_batch_record(
    app: &AppHandle,
    batch: CalendarEventBatchInput,
) -> Result<Vec<CalendarEvent>, String> {
    let _transaction = storage::transaction();
    let mut events = read_calendar_events(app);
    let mut created = Vec::with_capacity(batch.events.len());
    for input in batch.events {
        let event = calendar_event_from_input(input)?;
        events.push(event.clone());
        created.push(event);
    }
    persist_calendar_events(app, &events)?;
    let _ = app.emit("calendar-events-updated", ());
    Ok(created)
}

#[tauri::command]
fn create_calendar_event(
    app: AppHandle,
    input: CalendarEventInput,
) -> Result<CalendarEvent, String> {
    create_calendar_event_record(&app, input)
}

#[tauri::command]
fn delete_calendar_event(app: AppHandle, id: String) -> Result<(), String> {
    let _transaction = storage::transaction();
    let mut events = read_calendar_events(&app);
    let previous_len = events.len();
    events.retain(|event| event.id != id);
    if events.len() == previous_len {
        return Err("未找到该日程".to_string());
    }
    persist_calendar_events(&app, &events)?;
    crate::sync::calendar_sync::mark_local_events_deleted(&app, &[id])?;
    let _ = app.emit("calendar-events-updated", ());
    Ok(())
}

fn escape_icalendar_text(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace('\n', "\\n")
}

fn render_icalendar(events: &[CalendarEvent]) -> Result<String, String> {
    let mut lines = vec![
        "BEGIN:VCALENDAR".to_string(),
        "VERSION:2.0".to_string(),
        "PRODID:-//Piko//Local Calendar//EN".to_string(),
        "CALSCALE:GREGORIAN".to_string(),
    ];
    for event in events {
        let start = Local
            .timestamp_opt(event.start_at as i64, 0)
            .single()
            .ok_or_else(|| "日程开始时间无效".to_string())?
            .with_timezone(&chrono::Utc)
            .format("%Y%m%dT%H%M%SZ")
            .to_string();
        let end = Local
            .timestamp_opt(event.end_at as i64, 0)
            .single()
            .ok_or_else(|| "日程结束时间无效".to_string())?
            .with_timezone(&chrono::Utc)
            .format("%Y%m%dT%H%M%SZ")
            .to_string();
        lines.extend([
            "BEGIN:VEVENT".to_string(),
            format!("UID:{}@piko.local", escape_icalendar_text(&event.id)),
            format!("DTSTAMP:{}", chrono::Utc::now().format("%Y%m%dT%H%M%SZ")),
            format!("DTSTART:{start}"),
            format!("DTEND:{end}"),
            format!("SUMMARY:{}", escape_icalendar_text(&event.title)),
        ]);
        if let Some(location) = &event.location {
            lines.push(format!("LOCATION:{}", escape_icalendar_text(location)));
        }
        if let Some(notes) = &event.notes {
            lines.push(format!("DESCRIPTION:{}", escape_icalendar_text(notes)));
        }
        lines.push("END:VEVENT".to_string());
    }
    lines.push("END:VCALENDAR".to_string());
    Ok(format!("{}\r\n", lines.join("\r\n")))
}

fn validate_icalendar_path(path: &Path) -> Result<(), String> {
    if path.extension().and_then(|extension| extension.to_str()) == Some("ics") {
        Ok(())
    } else {
        Err("日程导出文件必须使用 .ics 扩展名".to_string())
    }
}

#[tauri::command]
fn export_calendar_events(app: AppHandle, path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    validate_icalendar_path(&path)?;
    fs::write(path, render_icalendar(&read_calendar_events(&app))?)
        .map_err(|error| format!("导出日程失败：{error}"))
}

#[tauri::command]
fn open_calendar_import(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    validate_icalendar_path(&path)?;
    if !path.exists() {
        return Err("日程导出文件不存在".to_string());
    }
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", ""]);
        command
    };
    #[cfg(target_os = "linux")]
    let mut command = Command::new("xdg-open");
    command
        .arg(path)
        .spawn()
        .map_err(|error| format!("无法打开系统日历导入：{error}"))?;
    Ok(())
}

#[tauri::command]
fn list_business_plugins(registry: State<'_, PluginRegistry>) -> Vec<PluginManifest> {
    registry.manifests()
}

#[tauri::command]
fn list_external_plugins(
    app: AppHandle,
    registry: State<'_, PluginRegistry>,
) -> Vec<InstalledPlugin> {
    registry.register_declarative_plugins(&app)
}

#[tauri::command]
fn list_provider_tools(provider: String, registry: State<'_, PluginRegistry>) -> Value {
    provider_tools(&provider, &registry.manifests())
}

#[tauri::command]
fn confirm_chat_action(
    app: AppHandle,
    registry: State<'_, PluginRegistry>,
    drafts: State<'_, ActionDrafts>,
    id: String,
    selected_indexes: Option<Vec<usize>>,
) -> Result<ActionExecution, String> {
    let mut draft = drafts
        .0
        .lock()
        .map_err(|_| "无法读取待确认动作".to_string())?
        .remove(&id)
        .ok_or_else(|| "该动作草稿已失效".to_string())?;
    if draft.plugin_id == "piko.calendar" && draft.tool_name == "create_event_batch" {
        let events = draft.arguments["events"]
            .as_array()
            .cloned()
            .ok_or_else(|| "批量日程参数无效".to_string())?;
        let selected_indexes = selected_indexes.unwrap_or_else(|| (0..events.len()).collect());
        if selected_indexes.is_empty() {
            return Err("请至少选择一条日程".to_string());
        }
        draft.arguments["events"] = Value::Array(
            selected_indexes
                .into_iter()
                .map(|index| {
                    events
                        .get(index)
                        .cloned()
                        .ok_or_else(|| "批量日程选择项无效".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?,
        );
    }
    let calendar_events = if draft.plugin_id == "piko.calendar" {
        read_calendar_events(&app)
    } else {
        Vec::new()
    };
    let conflict_note = if draft.plugin_id == "piko.calendar" && draft.tool_name == "create_event" {
        let input = calendar_event_input_from_value(&draft.arguments)?;
        calendar_conflict_note(&calendar_events, input.start_at, input.end_at)
    } else if draft.plugin_id == "piko.calendar" && draft.tool_name == "create_event_batch" {
        let batch = calendar_event_batch_input_from_value(&draft.arguments)?;
        let conflicts = batch
            .events
            .into_iter()
            .filter_map(|input| {
                calendar_conflict_note(&calendar_events, input.start_at, input.end_at)
            })
            .count();
        if conflicts > 0 {
            Some(format!(
                "提示：其中 {} 条日程与已有安排重叠，但已继续创建。",
                conflicts
            ))
        } else {
            None
        }
    } else {
        None
    };
    let plugin_id = draft.plugin_id.clone();
    let tool_name = draft.tool_name.clone();
    let is_calendar_batch = plugin_id == "piko.calendar" && tool_name == "create_event_batch";
    let result = registry.execute(
        &app,
        ToolCall {
            plugin_id: draft.plugin_id,
            tool_name: draft.tool_name,
            arguments: draft.arguments,
        },
    )?;
    let message = match plugin_id.as_str() {
        "piko.calendar" if is_calendar_batch => "已创建所选日程。",
        "piko.calendar" if matches!(tool_name.as_str(), "delete_event" | "delete_event_batch") => {
            "日程已删除。"
        }
        "piko.calendar" => "日程已创建。",
        "piko.memos" => "备忘录已创建。",
        "piko.reminders" if tool_name == "delete_reminder" => "提醒已删除。",
        _ => "提醒已创建。",
    };
    Ok(ActionExecution {
        message: conflict_note
            .map(|note| format!("{message}\n{note}"))
            .unwrap_or_else(|| message.to_string()),
        follow_up_prompt: format!(
            "系统已经执行用户确认的操作。执行结果如下：\n{}\n请用一句简洁的自然语言向用户确认结果，不要再次调用写入工具。",
            serde_json::to_string(&result).map_err(|error| error.to_string())?
        ),
        result,
    })
}

#[tauri::command]
fn reject_chat_action(drafts: State<'_, ActionDrafts>, id: String) -> Result<(), String> {
    drafts
        .0
        .lock()
        .map_err(|_| "无法读取待确认动作".to_string())?
        .remove(&id)
        .ok_or_else(|| "该动作草稿已失效".to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_reminder(app: AppHandle, id: String) -> Result<(), String> {
    let _transaction = storage::transaction();
    let mut reminders = read_reminders(&app);
    let previous_len = reminders.len();
    reminders.retain(|reminder| reminder.id != id);
    if reminders.len() == previous_len {
        return Err("未找到该提醒".to_string());
    }
    persist_reminders(&app, &reminders)?;
    let _ = app.emit_to("panel", "reminders-updated", ());
    Ok(())
}

fn collect_due_reminders(reminders: &mut [Reminder], now: u64) -> Vec<Reminder> {
    let mut due = Vec::new();
    for reminder in reminders {
        if reminder.status == "pending" && reminder.due_at <= now {
            due.push(reminder.clone());
            if reminder.repeat == "none" {
                reminder.status = "triggered".to_string();
            } else {
                reminder.due_at = next_repeat_due(reminder.due_at, &reminder.repeat, now);
            }
        }
    }
    due
}

fn process_due_reminders(app: &AppHandle) -> Result<Vec<Reminder>, String> {
    let _transaction = storage::transaction();
    let now = unix_timestamp();
    let mut reminders = read_reminders(app);
    let due = collect_due_reminders(&mut reminders, now);
    if due.is_empty() {
        return Ok(due);
    }

    persist_reminders(app, &reminders)?;
    for reminder in &due {
        let _ = app
            .notification()
            .builder()
            .title("Piko 提醒")
            .body(&reminder.title)
            .show();
        let _ = app.emit_to(
            "pet",
            "pet-visual-event",
            PetVisualEvent::ReminderFired {
                message: format!("提醒：{}", reminder.title),
            },
        );
    }
    let _ = app.emit_to("panel", "reminders-updated", ());
    Ok(due)
}

fn collect_due_calendar_events(
    events: &[CalendarEvent],
    now: u64,
    already_notified: &mut HashSet<String>,
) -> Vec<CalendarEvent> {
    const CALENDAR_EVENT_NOTICE_WINDOW_SECONDS: u64 = 60;

    events
        .iter()
        .filter(|event| {
            event.start_at <= now
                && now.saturating_sub(event.start_at) <= CALENDAR_EVENT_NOTICE_WINDOW_SECONDS
                && already_notified.insert(event.id.clone())
        })
        .cloned()
        .collect()
}

fn format_calendar_notice(event: &CalendarEvent) -> String {
    match event
        .location
        .as_deref()
        .map(str::trim)
        .filter(|location| !location.is_empty())
    {
        Some(location) => format!("日程：{} · {}", event.title, location),
        None => format!("日程：{}", event.title),
    }
}

fn process_due_calendar_events(app: &AppHandle) -> Result<Vec<CalendarEvent>, String> {
    let now = unix_timestamp();
    let events = read_calendar_events(app);
    let calendar_notifications = app.state::<CalendarNotificationCache>();
    let mut already_notified = calendar_notifications
        .0
        .lock()
        .map_err(|_| "无法读取日程提醒状态".to_string())?;
    let due = collect_due_calendar_events(&events, now, &mut already_notified);
    drop(already_notified);

    for event in &due {
        let message = format_calendar_notice(event);
        let _ = app
            .notification()
            .builder()
            .title("Piko 日程")
            .body(&message)
            .show();
        let _ = app.emit_to(
            "pet",
            "pet-visual-event",
            PetVisualEvent::CalendarEventDue { message },
        );
    }

    Ok(due)
}

fn watch_reminders(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || loop {
        let revision = storage::revision();
        if let Err(error) = process_due_reminders(&app) {
            eprintln!("[reminders] {error}");
        }
        let now = unix_timestamp();
        let delay = read_reminders(&app)
            .iter()
            .filter(|item| item.status == "pending")
            .map(|item| item.due_at.saturating_sub(now).clamp(1, 60))
            .min()
            .unwrap_or(60);
        storage::wait_for_change(revision, Duration::from_secs(delay));
    });
}

fn watch_calendar_events(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || loop {
        let revision = storage::revision();
        if let Err(error) = process_due_calendar_events(&app) {
            eprintln!("[calendar] {error}");
        }
        let now = unix_timestamp();
        let delay = read_calendar_events(&app)
            .iter()
            .filter(|item| item.start_at > now)
            .map(|item| item.start_at.saturating_sub(now).clamp(1, 60))
            .min()
            .unwrap_or(60);
        storage::wait_for_change(revision, Duration::from_secs(delay));
    });
}

fn focus_snapshot(app: &AppHandle, focus: &FocusTimer) -> Result<FocusSnapshot, String> {
    let now = unix_timestamp();
    let active = focus.0.lock().map_err(|_| "无法读取专注状态".to_string())?;
    let (status, kind, remaining_seconds) = active
        .as_ref()
        .map(|active| {
            let remaining = if active.status == "running" {
                active.end_at.saturating_sub(now)
            } else {
                active.remaining_seconds
            };
            (active.status.clone(), active.kind.clone(), remaining)
        })
        .unwrap_or_else(|| ("idle".to_string(), "focus".to_string(), 0));
    Ok(FocusSnapshot {
        status,
        kind,
        remaining_seconds,
        today_minutes: today_focus_minutes(&read_focus_records(app), now),
    })
}

fn emit_focus_updated(app: &AppHandle, focus: &FocusTimer) {
    if let Ok(snapshot) = focus_snapshot(app, focus) {
        let _ = app.emit_to("panel", "focus-updated", snapshot);
    }
}

fn work_rhythm_snapshot(
    app: &AppHandle,
    typing: &typing_activity::TypingActivityState,
    focus: &FocusTimer,
) -> Result<WorkRhythmState, String> {
    let settings = read_settings(app);
    let now = unix_timestamp();
    let focus_snapshot = focus_snapshot(app, focus)?;
    let typing_snapshot = typing.snapshot(now)?;
    let active_app_state = app.state::<app_awareness::ForegroundAppState>();
    let active_app_category = active_app_state
        .current_category
        .lock()
        .map_err(|_| "无法读取前台应用状态".to_string())?;
    let chat_active = app
        .state::<ChatRequests>()
        .0
        .lock()
        .map(|requests| !requests.is_empty())
        .unwrap_or(false);
    let focus_is_active = focus_snapshot.status == "running";
    let is_busy = chat_active
        || focus_is_active
        || matches!(
            *active_app_category,
            app_awareness::AppCategory::VideoConference | app_awareness::AppCategory::Game
        );
    let idle_seconds = system_idle_seconds().unwrap_or(0);
    let is_idle = !settings.sensing_paused
        && !is_busy
        && idle_seconds >= idle_threshold_seconds(&settings.quiet_mode);

    Ok(WorkRhythmState {
        date: chrono::Local::now().format("%Y-%m-%d").to_string(),
        is_idle,
        idle_seconds,
        active_app_category: active_app_category.to_string(),
        typing_characters_today: typing_snapshot.typed_characters,
        typing_seconds_today: typing_snapshot.typing_seconds,
        focus_status: focus_snapshot.status,
        focus_kind: focus_snapshot.kind,
        focus_remaining_seconds: focus_snapshot.remaining_seconds,
    })
}

fn emit_work_rhythm_updated(app: &AppHandle) {
    let typing = app.state::<typing_activity::TypingActivityState>();
    let focus = app.state::<FocusTimer>();
    if let Ok(snapshot) = work_rhythm_snapshot(app, &typing, &focus) {
        if let Ok(mut last) = app.state::<WorkRhythmCache>().0.lock() {
            if last.as_ref() != Some(&snapshot) {
                *last = Some(snapshot.clone());
                let _ = app.emit_to("panel", "work-rhythm-updated", snapshot.clone());
                if let Ok(typing_snapshot) = typing.snapshot(unix_timestamp()) {
                    let _ = app.emit_to("panel", "typing-stats-updated", typing_snapshot);
                }
            }
        }
    }
}

fn maybe_emit_break_reminder(app: &AppHandle) {
    let typing = app.state::<typing_activity::TypingActivityState>();
    let focus = app.state::<FocusTimer>();
    let settings = read_settings(app);
    let Ok(snapshot) = work_rhythm_snapshot(app, &typing, &focus) else {
        return;
    };

    if settings.sensing_paused
        || !settings.break_reminders_enabled
        || settings.quiet_mode == "minimal"
    {
        return;
    }
    if snapshot.is_idle || snapshot.focus_status == "running" || snapshot.focus_kind == "break" {
        return;
    }
    if matches!(
        snapshot.active_app_category.as_str(),
        "video_conference" | "game"
    ) {
        return;
    }

    if is_within_quiet_hours(
        &settings.break_reminder_quiet_hours_start,
        &settings.break_reminder_quiet_hours_end,
        settings.break_reminder_quiet_hours_enabled,
        unix_timestamp(),
    ) {
        return;
    }

    let interval_seconds = settings.break_reminder_interval_minutes.saturating_mul(60);
    let cooldown_seconds = settings.break_reminder_cooldown_minutes.saturating_mul(60);
    if interval_seconds == 0 || cooldown_seconds == 0 {
        return;
    }

    let bucket = snapshot.typing_seconds_today / interval_seconds;
    if bucket == 0 {
        return;
    }

    let now = unix_timestamp();
    let reminder_state = app.state::<WorkRhythmReminderCache>();
    let Ok(mut state) = reminder_state.0.lock() else {
        return;
    };
    if state.date != snapshot.date {
        *state = WorkRhythmReminderState {
            date: snapshot.date.clone(),
            last_sent_bucket: 0,
            last_notified_at: 0,
        };
    }
    if bucket <= state.last_sent_bucket {
        return;
    }
    if now.saturating_sub(state.last_notified_at) < cooldown_seconds {
        return;
    }

    let reminder_minutes = bucket.saturating_mul(settings.break_reminder_interval_minutes);
    let message = format!("你已经连续工作约 {reminder_minutes} 分钟了，要不要休息 5 分钟？");
    let _ = app
        .notification()
        .builder()
        .title("Piko 休息提醒")
        .body(&message)
        .show();
    let _ = app.emit_to(
        "pet",
        "pet-visual-event",
        PetVisualEvent::BreakReminder { message },
    );
    state.last_sent_bucket = bucket;
    state.last_notified_at = now;
}

fn parse_clock_minutes(value: &str) -> Option<u64> {
    let (hour, minute) = value.trim().split_once(':')?;
    let hour = hour.parse::<u64>().ok()?;
    let minute = minute.parse::<u64>().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    Some(hour * 60 + minute)
}

fn is_within_quiet_hours(start: &str, end: &str, enabled: bool, now: u64) -> bool {
    if !enabled {
        return false;
    }
    let Some(start_minutes) = parse_clock_minutes(start) else {
        return false;
    };
    let Some(end_minutes) = parse_clock_minutes(end) else {
        return false;
    };
    let Some(now_local) = Local.timestamp_opt(now as i64, 0).single() else {
        return false;
    };
    let current_minutes = (now_local.hour() as u64) * 60 + (now_local.minute() as u64);
    if start_minutes == end_minutes {
        return true;
    }
    if start_minutes < end_minutes {
        current_minutes >= start_minutes && current_minutes < end_minutes
    } else {
        current_minutes >= start_minutes || current_minutes < end_minutes
    }
}

#[tauri::command]
fn get_focus_state(app: AppHandle, focus: State<'_, FocusTimer>) -> Result<FocusSnapshot, String> {
    focus_snapshot(&app, &focus)
}

#[tauri::command]
fn get_typing_stats_today(app: AppHandle) -> Result<typing_activity::TypingStatsToday, String> {
    typing_activity::get_typing_stats_today(&app)
}

#[tauri::command]
fn get_work_rhythm_state(
    app: AppHandle,
    typing: State<'_, typing_activity::TypingActivityState>,
    focus: State<'_, FocusTimer>,
) -> Result<WorkRhythmState, String> {
    work_rhythm_snapshot(&app, &typing, &focus)
}

#[tauri::command]
fn start_focus(
    app: AppHandle,
    focus: State<'_, FocusTimer>,
    minutes: u64,
) -> Result<FocusSnapshot, String> {
    if !matches!(minutes, 15 | 25 | 45 | 60) {
        return Err("专注时长仅支持 15、25、45 或 60 分钟".to_string());
    }
    start_timer(&focus, "focus", minutes)?;
    let _ = app.emit_to("pet", "pet-visual-event", PetVisualEvent::FocusStarted);
    emit_focus_updated(&app, &focus);
    focus_snapshot(&app, &focus)
}

fn start_timer(focus: &FocusTimer, kind: &str, minutes: u64) -> Result<(), String> {
    *focus.0.lock().map_err(|_| "无法更新专注状态".to_string())? = Some(ActiveFocus {
        status: "running".to_string(),
        kind: kind.to_string(),
        end_at: unix_timestamp() + minutes * 60,
        remaining_seconds: minutes * 60,
        minutes,
    });
    Ok(())
}

#[tauri::command]
fn start_break(
    app: AppHandle,
    focus: State<'_, FocusTimer>,
    minutes: u64,
) -> Result<FocusSnapshot, String> {
    if !matches!(minutes, 5 | 10 | 15) {
        return Err("休息时长仅支持 5、10 或 15 分钟".to_string());
    }
    start_timer(&focus, "break", minutes)?;
    emit_focus_updated(&app, &focus);
    focus_snapshot(&app, &focus)
}

#[tauri::command]
fn pause_focus(app: AppHandle, focus: State<'_, FocusTimer>) -> Result<FocusSnapshot, String> {
    let now = unix_timestamp();
    {
        let mut active = focus.0.lock().map_err(|_| "无法更新专注状态".to_string())?;
        let active = active
            .as_mut()
            .ok_or_else(|| "当前没有专注计时".to_string())?;
        if active.status == "running" {
            active.remaining_seconds = active.end_at.saturating_sub(now);
            active.status = "paused".to_string();
        }
    }
    emit_focus_updated(&app, &focus);
    focus_snapshot(&app, &focus)
}

#[tauri::command]
fn resume_focus(app: AppHandle, focus: State<'_, FocusTimer>) -> Result<FocusSnapshot, String> {
    {
        let mut active = focus.0.lock().map_err(|_| "无法更新专注状态".to_string())?;
        let active = active
            .as_mut()
            .ok_or_else(|| "当前没有专注计时".to_string())?;
        if active.status == "paused" {
            active.end_at = unix_timestamp() + active.remaining_seconds;
            active.status = "running".to_string();
        }
    }
    emit_focus_updated(&app, &focus);
    focus_snapshot(&app, &focus)
}

#[tauri::command]
fn stop_focus(app: AppHandle, focus: State<'_, FocusTimer>) -> Result<FocusSnapshot, String> {
    *focus.0.lock().map_err(|_| "无法更新专注状态".to_string())? = None;
    emit_focus_updated(&app, &focus);
    focus_snapshot(&app, &focus)
}

fn normalize_clock_label(value: &str) -> Result<String, String> {
    let Some(minutes) = parse_clock_minutes(value) else {
        return Err("静默时段时间格式应为 HH:MM".to_string());
    };
    let hour = minutes / 60;
    let minute = minutes % 60;
    Ok(format!("{hour:02}:{minute:02}"))
}

fn validate_work_rhythm_preferences(input: &WorkRhythmPreferencesInput) -> Result<(), String> {
    if !(15..=240).contains(&input.break_reminder_interval_minutes) {
        return Err("休息提醒间隔应在 15 到 240 分钟之间".to_string());
    }
    if !(5..=240).contains(&input.break_reminder_cooldown_minutes) {
        return Err("休息提醒冷却应在 5 到 240 分钟之间".to_string());
    }
    let _ = normalize_clock_label(&input.break_reminder_quiet_hours_start)?;
    let _ = normalize_clock_label(&input.break_reminder_quiet_hours_end)?;
    Ok(())
}

fn process_focus_timer(app: &AppHandle, focus: &FocusTimer) -> Result<bool, String> {
    let now = unix_timestamp();
    let completed = {
        let mut active = focus.0.lock().map_err(|_| "无法读取专注状态".to_string())?;
        if active
            .as_ref()
            .is_some_and(|active| active.status == "running" && active.end_at <= now)
        {
            active.take()
        } else {
            None
        }
    };
    let Some(completed) = completed else {
        return Ok(false);
    };

    if completed.kind == "focus" {
        let _transaction = storage::transaction();
        let mut records = read_focus_records(app);
        records.push(FocusRecord {
            completed_at: now,
            minutes: completed.minutes,
        });
        persist_focus_records(app, &records)?;
    }
    let message = if completed.kind == "break" {
        "休息结束，可以开始下一轮专注了。"
    } else {
        "专注结束，休息一下吧。"
    };
    let _ = app
        .notification()
        .builder()
        .title("Piko 专注")
        .body(message)
        .show();
    let _ = app.emit_to("pet", "pet-visual-event", PetVisualEvent::FocusCompleted);
    emit_focus_updated(app, focus);
    Ok(true)
}

fn watch_focus_timer(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || loop {
        let focus = app.state::<FocusTimer>();
        let _ = process_focus_timer(&app, &focus);
        thread::sleep(Duration::from_secs(1));
    });
}

fn watch_ambient_nudges(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || loop {
        let settings = read_settings(&app);
        let delay = match settings.quiet_mode.as_str() {
            "active" => 45,
            "minimal" => 300,
            _ => 120,
        };
        thread::sleep(Duration::from_secs(delay));
        if !settings.sensing_paused && settings.quiet_mode != "minimal" {
            let _ = app.emit_to("pet", "pet-visual-event", PetVisualEvent::AmbientNudge);
        }
    });
}

fn idle_threshold_seconds(quiet_mode: &str) -> u64 {
    match quiet_mode {
        "active" => 60,
        "minimal" => 300,
        _ => 120,
    }
}

fn next_idle_state(
    was_idle: bool,
    settings: &AppSettings,
    idle_seconds: u64,
    is_busy: bool,
) -> (bool, Option<PetVisualEvent>) {
    let should_rest = !settings.sensing_paused
        && !is_busy
        && idle_seconds >= idle_threshold_seconds(&settings.quiet_mode);

    match (was_idle, should_rest, is_busy) {
        (false, true, _) => (true, Some(PetVisualEvent::IdleStarted)),
        (true, false, false) => (false, Some(PetVisualEvent::IdleEnded)),
        (true, false, true) => (false, None),
        _ => (was_idle, None),
    }
}

#[cfg(target_os = "macos")]
fn system_idle_seconds() -> Option<u64> {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state_id: i32, event_type: u32) -> f64;
    }

    const HID_SYSTEM_STATE: i32 = 1;
    const ANY_INPUT_EVENT_TYPE: u32 = u32::MAX;
    let seconds =
        unsafe { CGEventSourceSecondsSinceLastEventType(HID_SYSTEM_STATE, ANY_INPUT_EVENT_TYPE) };
    seconds.is_finite().then_some(seconds.max(0.0) as u64)
}

#[cfg(target_os = "windows")]
fn system_idle_seconds() -> Option<u64> {
    #[repr(C)]
    struct LastInputInfo {
        size: u32,
        tick_count: u32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetLastInputInfo(info: *mut LastInputInfo) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetTickCount() -> u32;
    }

    let mut info = LastInputInfo {
        size: std::mem::size_of::<LastInputInfo>() as u32,
        tick_count: 0,
    };
    if unsafe { GetLastInputInfo(&mut info) } == 0 {
        return None;
    }
    Some(unsafe { GetTickCount() }.wrapping_sub(info.tick_count) as u64 / 1000)
}

#[cfg(target_os = "linux")]
fn system_idle_seconds() -> Option<u64> {
    Command::new("xprintidle")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|milliseconds| milliseconds.trim().parse::<u64>().ok())
        .map(|milliseconds| milliseconds / 1000)
}

fn watch_idle_detection(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || loop {
        if let Some(idle_seconds) = system_idle_seconds() {
            let settings = read_settings(&app);
            let chat_is_active = app
                .state::<ChatRequests>()
                .0
                .lock()
                .map(|requests| !requests.is_empty())
                .unwrap_or(false);
            let focus_is_active = app
                .state::<FocusTimer>()
                .0
                .lock()
                .map(|focus| focus.is_some())
                .unwrap_or(false);
            let idle = app.state::<IdleDetection>();
            if let Ok(mut was_idle) = idle.0.lock() {
                let (is_idle, event) = next_idle_state(
                    *was_idle,
                    &settings,
                    idle_seconds,
                    chat_is_active || focus_is_active,
                );
                *was_idle = is_idle;
                if let Some(event) = event {
                    let _ = app.emit_to("pet", "pet-visual-event", event);
                }
            };
        }
        thread::sleep(Duration::from_secs(2));
    });
}

/// Watch the foreground application and update pet behavior accordingly.
fn watch_foreground_app(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || loop {
        if let Some(name) = app_awareness::get_foreground_app_name() {
            let category = app_awareness::classify(&name);
            let state = app.state::<app_awareness::ForegroundAppState>();

            // Update state
            if let Ok(mut cat) = state.current_category.lock() {
                *cat = category;
            }
            if let Ok(mut last) = state.last_app_name.lock() {
                *last = Some(name.clone());
            }

            // Check if sensing is paused
            let paused = state.sensing_paused.lock().map(|p| *p).unwrap_or(false);
            if !paused {
                let _ = app.emit_to(
                    "pet",
                    "foreground-app-changed",
                    json!({
                        "category": format!("{category}"),
                        "appName": name,
                    }),
                );
            }
            emit_work_rhythm_updated(&app);
        }
        thread::sleep(Duration::from_secs(5));
    });
}

fn watch_work_rhythm(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || loop {
        emit_work_rhythm_updated(&app);
        maybe_emit_break_reminder(&app);
        thread::sleep(Duration::from_secs(2));
    });
}

fn validate_save_path(path: &Path) -> Result<(), String> {
    const ALLOWED_EXTENSIONS: [&str; 12] = [
        "txt", "md", "json", "csv", "py", "js", "ts", "html", "css", "rs", "toml", "log",
    ];
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|extension| ALLOWED_EXTENSIONS.contains(&extension.as_str()))
        .ok_or_else(|| "不支持该文件类型".to_string())?;
    Ok(())
}

#[tauri::command]
fn save_generated_text(path: String, content: String, overwrite: bool) -> Result<(), String> {
    let path = PathBuf::from(path);
    validate_save_path(&path)?;
    if path.exists() && !overwrite {
        return Err("目标文件已存在，需要确认覆盖".to_string());
    }
    fs::write(path, content).map_err(|error| format!("保存文件失败：{error}"))
}

fn read_text_attachment(path: &Path) -> Result<(TextAttachment, AttachmentPreview), String> {
    const ALLOWED_EXTENSIONS: [&str; 5] = ["txt", "md", "json", "csv", "log"];

    let metadata = fs::metadata(path).map_err(|_| "无法读取该文件".to_string())?;
    if !metadata.is_file() {
        return Err("请拖入单个文本文件".to_string());
    }
    if metadata.len() > MAX_TEXT_ATTACHMENT_BYTES {
        return Err("文件过大，请选择不超过 1 MiB 的文本文件".to_string());
    }

    path.extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|extension| ALLOWED_EXTENSIONS.contains(&extension.as_str()))
        .ok_or_else(|| "仅支持 .txt、.md、.json、.csv 和 .log 文件".to_string())?;
    let display_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| "无法识别文件名".to_string())?
        .to_string();
    let content = fs::read_to_string(path).map_err(|_| "文件不是有效的 UTF-8 文本".to_string())?;
    let char_count = content.chars().count();
    let mut preview = content
        .chars()
        .take(MAX_TEXT_ATTACHMENT_PREVIEW_CHARS)
        .collect::<String>();
    if char_count > MAX_TEXT_ATTACHMENT_PREVIEW_CHARS {
        preview.push('…');
    }

    Ok((
        TextAttachment {
            display_name: display_name.clone(),
            content,
        },
        AttachmentPreview {
            display_name,
            byte_size: metadata.len(),
            char_count,
            preview,
        },
    ))
}

#[tauri::command]
fn prepare_text_attachment(
    app: AppHandle,
    attachments: State<'_, TextAttachmentStore>,
    path: String,
) -> Result<AttachmentPreview, String> {
    let (attachment, preview) = read_text_attachment(Path::new(&path))?;
    *attachments
        .0
        .lock()
        .map_err(|_| "无法保存附件状态".to_string())? = Some(attachment);
    let _ = app.emit_to("pet", "pet-visual-event", PetVisualEvent::AttachmentReady);
    Ok(preview)
}

#[tauri::command]
fn clear_text_attachment(attachments: State<'_, TextAttachmentStore>) -> Result<(), String> {
    *attachments
        .0
        .lock()
        .map_err(|_| "无法清除附件状态".to_string())? = None;
    Ok(())
}

#[tauri::command]
fn update_quiet_mode(app: AppHandle, quiet_mode: String) -> Result<AppSettings, String> {
    let _transaction = storage::transaction();
    if !["active", "balanced", "minimal"].contains(&quiet_mode.as_str()) {
        return Err("Unsupported quiet mode".to_string());
    }

    let mut settings = read_settings(&app);
    settings.quiet_mode = quiet_mode;
    persist_settings(&app, &settings)?;
    let _ = app.emit_to("panel", "settings-updated", &settings);
    let _ = app.emit_to("pet", "settings-updated", &settings);
    let _ = app.emit_to("bubble", "settings-updated", &settings);
    emit_work_rhythm_updated(&app);
    Ok(settings)
}

#[tauri::command]
fn update_preferences(
    app: AppHandle,
    awareness: State<'_, app_awareness::ForegroundAppState>,
    input: PreferencesInput,
) -> Result<AppSettings, String> {
    let _transaction = storage::transaction();
    let companion_name = input.companion_name.trim();
    if companion_name.is_empty() {
        return Err("精灵名称不能为空".to_string());
    }
    if companion_name.chars().count() > 24 {
        return Err("精灵名称不能超过 24 个字符".to_string());
    }
    if !["sage", "blue", "peach"].contains(&input.theme.as_str()) {
        return Err("不支持的主题色".to_string());
    }

    let mut settings = read_settings(&app);
    settings.companion_name = companion_name.to_string();
    settings.theme = input.theme;
    settings.sensing_paused = input.sensing_paused;
    persist_settings(&app, &settings)?;
    if let Ok(mut paused) = awareness.sensing_paused.lock() {
        *paused = settings.sensing_paused;
    }
    let _ = app.emit_to("pet", "settings-updated", &settings);
    let _ = app.emit_to("bubble", "settings-updated", &settings);
    emit_work_rhythm_updated(&app);
    Ok(settings)
}

#[tauri::command]
fn update_work_rhythm_preferences(
    app: AppHandle,
    input: WorkRhythmPreferencesInput,
) -> Result<AppSettings, String> {
    let _transaction = storage::transaction();
    validate_work_rhythm_preferences(&input)?;

    let mut settings = read_settings(&app);
    settings.break_reminders_enabled = input.break_reminders_enabled;
    settings.break_reminder_interval_minutes = input.break_reminder_interval_minutes;
    settings.break_reminder_cooldown_minutes = input.break_reminder_cooldown_minutes;
    settings.break_reminder_quiet_hours_enabled = input.break_reminder_quiet_hours_enabled;
    settings.break_reminder_quiet_hours_start =
        normalize_clock_label(&input.break_reminder_quiet_hours_start)?;
    settings.break_reminder_quiet_hours_end =
        normalize_clock_label(&input.break_reminder_quiet_hours_end)?;
    persist_settings(&app, &settings)?;
    let _ = app.emit_to("panel", "settings-updated", &settings);
    let _ = app.emit_to("pet", "settings-updated", &settings);
    let _ = app.emit_to("bubble", "settings-updated", &settings);
    emit_work_rhythm_updated(&app);
    Ok(settings)
}

#[tauri::command]
fn update_ai_settings(app: AppHandle, input: AiSettingsInput) -> Result<AppSettings, String> {
    let _transaction = storage::transaction();
    let ai = AiSettings {
        provider: input.provider,
        base_url: normalize_base_url(&input.base_url),
        model: input.model.trim().to_string(),
        speech_model: input
            .speech_model
            .unwrap_or_else(default_speech_model)
            .trim()
            .to_string(),
        temperature: input.temperature,
        timeout_seconds: input.timeout_seconds,
    };
    validate_ai_settings(&ai)?;
    update_api_key(input.api_key)?;

    let mut settings = read_settings(&app);
    settings.ai = ai;
    settings.has_api_key = read_api_key().is_some();
    persist_settings(&app, &settings)?;
    Ok(settings)
}

#[tauri::command]
fn get_speech_model_status(app: AppHandle) -> Vec<SpeechModelStatus> {
    speech_model_definitions()
        .iter()
        .map(|definition| speech_model_status(&app, definition))
        .collect()
}

#[tauri::command]
async fn download_speech_model(
    app: AppHandle,
    input: DownloadSpeechModelInput,
) -> Result<SpeechModelStatus, String> {
    let definition =
        speech_model_definition(&input.model_id).ok_or_else(|| "不支持的语音模型".to_string())?;
    let directory = speech_models_dir(&app)?;
    fs::create_dir_all(&directory).map_err(|error| format!("创建模型目录失败：{error}"))?;

    if speech_model_status(&app, definition).downloaded {
        return Ok(speech_model_status(&app, definition));
    }

    let archive_name = format!("{}.tar.bz2", definition.archive_dir);
    let temp_path = directory.join(format!("{archive_name}.download"));
    let final_path = directory.join(&archive_name);

    let response = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(1800))
        .build()
        .map_err(|error| error.to_string())?
        .get(definition.download_url)
        .header(reqwest::header::USER_AGENT, "Piko-Desktop-Companion")
        .send()
        .await
        .map_err(|error| format!("下载语音模型失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("下载语音模型失败：{error}"))?;
    let total_bytes = response.content_length();
    let mut stream = response.bytes_stream();
    let mut file =
        fs::File::create(&temp_path).map_err(|error| format!("创建模型文件失败：{error}"))?;
    let mut downloaded_bytes = 0u64;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("读取模型下载数据失败：{error}"))?;
        file.write_all(&chunk)
            .map_err(|error| format!("写入模型文件失败：{error}"))?;
        downloaded_bytes += chunk.len() as u64;
        let progress = SpeechModelDownloadProgress {
            model_id: definition.id.to_string(),
            downloaded_bytes,
            total_bytes,
            percent: total_bytes.map(|total| downloaded_bytes as f32 / total as f32),
            completed: false,
        };
        let _ = app.emit_to("panel", "speech-model-download-progress", progress);
    }
    file.flush()
        .map_err(|error| format!("保存模型文件失败：{error}"))?;
    drop(file);

    fs::rename(&temp_path, &final_path).map_err(|error| format!("保存压缩包失败：{error}"))?;
    let decoder = bzip2::read::BzDecoder::new(
        fs::File::open(&final_path).map_err(|error| format!("打开压缩包失败：{error}"))?,
    );
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(&directory)
        .map_err(|error| format!("解压模型失败：{error}"))?;
    fs::remove_file(&final_path).map_err(|error| format!("清理压缩包失败：{error}"))?;

    let progress = SpeechModelDownloadProgress {
        model_id: definition.id.to_string(),
        downloaded_bytes,
        total_bytes,
        percent: Some(1.0),
        completed: true,
    };
    let _ = app.emit_to("panel", "speech-model-download-progress", progress);
    Ok(speech_model_status(&app, definition))
}

#[tauri::command]
async fn transcribe_voice_input(
    app: AppHandle,
    input: VoiceTranscriptionInput,
) -> Result<VoiceTranscriptionOutput, String> {
    let (_, encoded_audio) = parse_data_url(&input.audio_data_url)?;
    let audio_bytes = BASE64_STANDARD
        .decode(encoded_audio)
        .map_err(|error| format!("录音数据解析失败：{error}"))?;
    if audio_bytes.is_empty() {
        return Err("没有录到语音内容。".to_string());
    }
    if audio_bytes.len() > 25 * 1024 * 1024 {
        return Err("录音太长，请缩短后重试。".to_string());
    }

    let definition = speech_model_definitions()
        .first()
        .ok_or_else(|| "未配置语音模型".to_string())?;
    if !speech_model_status(&app, definition).downloaded {
        return Err(format!(
            "请先在设置中下载 {}，再使用语音输入。",
            definition.name
        ));
    }

    let (sample_rate, samples) = decode_wav_pcm16_mono(&audio_bytes)?;
    let audio = resample_to_16khz(sample_rate, &samples);
    let model_path = speech_model_path(&app, definition)?;
    let tokens_path = sense_voice_tokens_path(&app, definition)?;
    let text = tauri::async_runtime::spawn_blocking(move || {
        transcribe_with_sense_voice(model_path, tokens_path, audio, 16_000)
    })
    .await
    .map_err(|error| format!("本地语音转写任务失败：{error}"))??;

    if text.is_empty() {
        return Err("语音模型没有识别到文字。".to_string());
    }
    Ok(VoiceTranscriptionOutput { text })
}

#[tauri::command]
async fn generate_pet_companion_response(
    app: AppHandle,
    input: PetCompanionGenerationInput,
) -> Result<PetCompanionGenerationOutput, String> {
    let settings = read_settings(&app);
    validate_ai_settings(&settings.ai)?;

    let client = http_client(&settings.ai)?;
    let prompt = pet_companion_generation_user_prompt(&input);
    let request_body = match provider_kind(&settings.ai.provider) {
        Some(ProviderKind::OpenAiCompatible) => json!({
            "model": settings.ai.model,
            "messages": [
                { "role": "system", "content": pet_companion_generation_system_prompt(&settings.companion_name) },
                { "role": "user", "content": prompt },
            ],
            "temperature": settings.ai.temperature,
            "stream": false,
            "max_tokens": 256
        }),
        Some(ProviderKind::Anthropic) => json!({
            "model": settings.ai.model,
            "system": pet_companion_generation_system_prompt(&settings.companion_name),
            "messages": [
                { "role": "user", "content": prompt },
            ],
            "temperature": settings.ai.temperature,
            "max_tokens": 256
        }),
        Some(ProviderKind::Gemini) => json!({
            "systemInstruction": { "parts": [{ "text": pet_companion_generation_system_prompt(&settings.companion_name) }] },
            "contents": [
                { "role": "user", "parts": [{ "text": prompt }] }
            ],
            "generationConfig": { "temperature": settings.ai.temperature, "maxOutputTokens": 256 }
        }),
        None => return Err("不支持的模型服务类型".to_string()),
    };

    let response = request_builder(
        &client,
        &settings.ai,
        reqwest::Method::POST,
        pet_companion_generation_url(&settings.ai)?,
    )
    .json(&request_body)
    .send()
    .await
    .map_err(|error| error.to_string())?
    .error_for_status()
    .map_err(|error| error.to_string())?;

    let body = response
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;
    parse_pet_companion_generation_output(&settings.ai.provider, &body)
}

#[tauri::command]
fn update_html_preview_enabled(app: AppHandle, enabled: bool) -> Result<AppSettings, String> {
    let _transaction = storage::transaction();
    let mut settings = read_settings(&app);
    settings.html_preview_enabled = enabled;
    persist_settings(&app, &settings)?;
    let _ = app.emit_to("panel", "settings-updated", &settings);
    let _ = app.emit_to("pet", "settings-updated", &settings);
    let _ = app.emit_to("bubble", "settings-updated", &settings);
    Ok(settings)
}

#[tauri::command]
async fn list_models(app: AppHandle) -> Result<Vec<ModelInfo>, String> {
    let settings = read_settings(&app);
    validate_ai_settings(&settings.ai)?;
    let client = http_client(&settings.ai)?;
    let response = request_builder(
        &client,
        &settings.ai,
        reqwest::Method::GET,
        models_url(&settings.ai),
    )
    .send()
    .await
    .map_err(|error| error.to_string())?
    .error_for_status()
    .map_err(|error| error.to_string())?;
    let body = response
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;

    Ok(extract_model_ids(&settings.ai.provider, &body)
        .into_iter()
        .map(|id| ModelInfo { id })
        .collect())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OnboardingStatus {
    required: bool,
    completed: bool,
    version: String,
}

#[tauri::command]
fn get_onboarding_status(app: AppHandle) -> OnboardingStatus {
    let settings = read_settings(&app);
    OnboardingStatus {
        required: !settings.onboarding_completed,
        completed: settings.onboarding_completed,
        version: settings.onboarding_version.clone(),
    }
}

#[tauri::command]
fn complete_onboarding(
    app: AppHandle,
    companion_name: String,
    onboarding_version: String,
) -> Result<AppSettings, String> {
    let _transaction = storage::transaction();
    let mut settings = read_settings(&app);
    settings.onboarding_completed = true;
    settings.onboarding_version = onboarding_version;
    if !companion_name.trim().is_empty() {
        settings.companion_name = companion_name;
    }
    persist_settings(&app, &settings)?;
    let _ = app.emit("settings-updated", &settings);
    Ok(settings)
}

#[tauri::command]
fn skip_onboarding(app: AppHandle) -> Result<AppSettings, String> {
    let _transaction = storage::transaction();
    let mut settings = read_settings(&app);
    settings.onboarding_completed = true;
    settings.onboarding_version = "skipped".to_string();
    persist_settings(&app, &settings)?;
    let _ = app.emit("settings-updated", &settings);
    Ok(settings)
}

#[tauri::command]
fn reset_onboarding(app: AppHandle) -> Result<AppSettings, String> {
    let _transaction = storage::transaction();
    let mut settings = read_settings(&app);
    settings.onboarding_completed = false;
    settings.onboarding_version = String::new();
    persist_settings(&app, &settings)?;
    let _ = app.emit("settings-updated", &settings);
    Ok(settings)
}

// ============================================================================
// FOREGROUND APP AWARENESS COMMANDS
// ============================================================================

#[tauri::command]
fn get_foreground_app_state(
    awareness: State<'_, crate::app_awareness::ForegroundAppState>,
) -> Result<serde_json::Value, String> {
    let category = awareness
        .current_category
        .lock()
        .map_err(|_| "无法读取前台应用状态".to_string())?;
    let sensing_paused = awareness
        .sensing_paused
        .lock()
        .map_err(|_| "无法读取感知状态".to_string())?;
    let app_name = awareness
        .last_app_name
        .lock()
        .map_err(|_| "无法读取应用名称".to_string())?;

    Ok(json!({
        "category": format!("{:?}", category),
        "appName": app_name.as_deref().unwrap_or(""),
        "sensingPaused": *sensing_paused,
    }))
}

#[tauri::command]
fn toggle_foreground_sensing(
    app: AppHandle,
    awareness: State<'_, crate::app_awareness::ForegroundAppState>,
    paused: bool,
) -> Result<(), String> {
    let mut sensing_paused = awareness
        .sensing_paused
        .lock()
        .map_err(|_| "无法设置感知状态".to_string())?;
    *sensing_paused = paused;
    let _ = app.emit("foreground-sensing-changed", json!({ "paused": paused }));
    emit_work_rhythm_updated(&app);
    Ok(())
}

// ============================================================================
// DATA IMPORT/EXPORT COMMANDS
// ============================================================================

#[tauri::command]
fn export_data(app: AppHandle) -> Result<serde_json::Value, String> {
    let export = crate::sync::import_export::build_export_data(&app);
    serde_json::to_value(export).map_err(|e| e.to_string())
}

#[tauri::command]
fn export_to_file(app: AppHandle, file_path: String) -> Result<(), String> {
    let path = std::path::Path::new(&file_path);
    crate::sync::import_export::export_to_file(&app, path)
}

#[tauri::command]
fn preview_import(file_path: String) -> Result<serde_json::Value, String> {
    let path = std::path::Path::new(&file_path);
    let preview = crate::sync::import_export::preview_import(path)?;
    serde_json::to_value(preview).map_err(|e| e.to_string())
}

#[tauri::command]
fn import_data(
    app: AppHandle,
    focus: State<'_, FocusTimer>,
    file_path: String,
) -> Result<serde_json::Value, String> {
    let path = std::path::Path::new(&file_path);
    let result = crate::sync::import_export::import_from_file(&app, path)?;
    if result.chats_imported > 0 {
        let _ = app.emit_to("panel", "chat-history-updated", ());
    }
    if result.reminders_imported > 0 {
        let _ = app.emit_to("panel", "reminders-updated", ());
    }
    if result.calendar_imported > 0 {
        let _ = app.emit("calendar-events-updated", ());
    }
    if result.focus_imported > 0 {
        emit_focus_updated(&app, &focus);
    }
    if result.settings_imported {
        let settings = read_settings(&app);
        let _ = app.emit_to("panel", "settings-updated", &settings);
        let _ = app.emit_to("pet", "settings-updated", &settings);
        let _ = app.emit_to("bubble", "settings-updated", &settings);
    }
    serde_json::to_value(result).map_err(|e| e.to_string())
}

// ============================================================================
// CALENDAR SYNC COMMANDS
// ============================================================================

#[tauri::command]
fn get_calendar_sync_status(app: AppHandle) -> Result<serde_json::Value, String> {
    let mappings = crate::sync::calendar_sync::read_sync_mappings(&app);
    let available = crate::sync::calendar_sync::is_sync_available();
    let platform = crate::sync::calendar_sync::current_platform();

    Ok(json!({
        "platform": platform,
        "available": available,
        "mappingCount": mappings.len(),
        "lastSync": mappings.iter().map(|m| m.last_synced_at).max(),
    }))
}

#[tauri::command]
fn sync_calendar_to_system(app: AppHandle) -> Result<serde_json::Value, String> {
    let events = read_calendar_events(&app);
    let result = crate::sync::calendar_sync::push_to_system_calendar(&app, &events)?;
    let _ = app.emit_to("panel", "calendar-sync-updated", ());
    Ok(json!({
        "pushed": result.pushed,
        "mappingCount": result.mappings.len(),
    }))
}

#[tauri::command]
fn sync_calendar_from_system(app: AppHandle) -> Result<serde_json::Value, String> {
    // Write debug log to temp file for troubleshooting
    let log_path = std::env::temp_dir().join("piko_calendar_debug.log");
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .and_then(|mut f| {
            std::io::Write::write_all(
                &mut f,
                format!("[{ts}] sync_calendar_from_system: command invoked\n").as_bytes(),
            )
        });

    let since = crate::sync::calendar_sync::read_sync_mappings(&app)
        .iter()
        .map(|mapping| mapping.last_synced_at)
        .max()
        .unwrap_or(0);
    let result = crate::sync::calendar_sync::pull_from_system_calendar(&app, since)?;
    let _ = app.emit("calendar-events-updated", ());
    let _ = app.emit_to("panel", "calendar-sync-updated", ());
    Ok(json!({
        "imported": result.imported,
        "events": result.events,
    }))
}

// ============================================================================
// EXTENDED UPDATE COMMANDS
// ============================================================================

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateStatus {
    current_version: String,
    latest_version: String,
    available: bool,
    release_url: String,
    release_notes: Option<String>,
    download_url: Option<String>,
    asset_name: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadedUpdate {
    file_path: String,
    file_name: String,
    downloaded_bytes: u64,
}

#[tauri::command]
async fn check_for_updates_extended() -> Result<UpdateStatus, String> {
    let base = check_for_updates().await?;

    // Try to fetch more details from GitHub Releases
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get("https://api.github.com/repos/Martinsuper/im-robot/releases/latest")
        .header("User-Agent", "im-robot-update-checker")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Ok(UpdateStatus {
            current_version: base.current_version,
            latest_version: base.latest_version,
            available: base.available,
            release_url: base.release_url,
            release_notes: None,
            download_url: None,
            asset_name: None,
        });
    }

    let release: Value = response.json().await.map_err(|e| e.to_string())?;
    let latest = release["tag_name"]
        .as_str()
        .unwrap_or("unknown")
        .trim_start_matches('v')
        .to_string();
    let current = env!("CARGO_PKG_VERSION").to_string();

    let available = version_parts(&latest) > version_parts(&current);

    let release_notes = release["body"]
        .as_str()
        .map(|s| s.lines().take(10).collect::<Vec<_>>().join("\n"));

    let download_url = release["assets"].as_array().and_then(|assets| {
        assets
            .iter()
            .find(|asset| {
                let name = asset["name"].as_str().unwrap_or("");
                cfg!(target_os = "macos") && name.ends_with(".dmg")
                    || cfg!(target_os = "windows") && name.ends_with(".exe")
            })
            .and_then(|asset| asset["browser_download_url"].as_str())
            .map(String::from)
    });

    let asset_name = release["assets"].as_array().and_then(|assets| {
        assets
            .iter()
            .find(|asset| {
                let name = asset["name"].as_str().unwrap_or("");
                cfg!(target_os = "macos") && name.ends_with(".dmg")
                    || cfg!(target_os = "windows") && name.ends_with(".exe")
            })
            .and_then(|asset| asset["name"].as_str())
            .map(String::from)
    });

    Ok(UpdateStatus {
        current_version: current,
        latest_version: latest,
        available,
        release_url: release["html_url"]
            .as_str()
            .unwrap_or(&base.release_url)
            .to_string(),
        release_notes,
        download_url,
        asset_name,
    })
}

#[tauri::command]
async fn download_update_asset(
    app: AppHandle,
    download_url: String,
    asset_name: Option<String>,
) -> Result<DownloadedUpdate, String> {
    if download_url.trim().is_empty() {
        return Err("未提供可下载的更新地址".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(download_url.trim())
        .header("User-Agent", "im-robot-update-downloader")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;

    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let file_name = asset_name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "piko-update.bin".to_string());
    let cache_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let update_dir = cache_dir.join("updates");
    std::fs::create_dir_all(&update_dir).map_err(|e| e.to_string())?;
    let file_path = update_dir.join(&file_name);
    std::fs::write(&file_path, &bytes).map_err(|e| e.to_string())?;

    Ok(DownloadedUpdate {
        file_path: file_path.to_string_lossy().to_string(),
        file_name,
        downloaded_bytes: bytes.len() as u64,
    })
}

fn configure_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show_pet = MenuItem::with_id(app, "show_pet", "Show Piko", true, None::<&str>)?;
    let hide_pet = MenuItem::with_id(app, "hide_pet", "Hide Piko", true, None::<&str>)?;
    let open_panel = MenuItem::with_id(app, "open_panel", "Open Assistant", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_pet, &hide_pet, &open_panel, &quit])?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().expect("application icon").clone())
        .tooltip("Piko Desktop AI Pet")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show_pet" => show_and_focus(app, "pet"),
            "hide_pet" => {
                if let Some(window) = app.get_webview_window("pet") {
                    let _ = window.hide();
                }
            }
            "open_panel" => show_and_focus(app, "panel"),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_and_focus(tray.app_handle(), "pet");
            }
        })
        .build(app)?;

    Ok(())
}

fn configure_global_shortcut(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    let primary_modifier = Modifiers::SUPER;
    #[cfg(not(target_os = "macos"))]
    let primary_modifier = Modifiers::CONTROL;
    let shortcut = Shortcut::new(Some(primary_modifier | Modifiers::SHIFT), Code::Space);

    app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, registered, event| {
                if registered == &shortcut && event.state() == ShortcutState::Pressed {
                    show_and_focus(app, "bubble");
                }
            })
            .build(),
    )?;

    app.global_shortcut().register(shortcut)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ChatRequests::default())
        .manage(ChatContext::default())
        .manage(PluginRegistry::with_builtin_plugins())
        .manage(ActionDrafts::default())
        .manage(LocalTts::default())
        .manage(FocusTimer::default())
        .manage(IdleDetection::default())
        .manage(WorkRhythmCache::default())
        .manage(WorkRhythmReminderCache::default())
        .manage(CalendarNotificationCache::default())
        .manage(TextAttachmentStore::default())
        .manage(ScreenCaptureStore::default())
        .manage(app_awareness::ForegroundAppState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            // Initialize memory database
            let memory_db = memory::init_memory_db(app.handle()).expect("无法初始化内存数据库");
            app.manage(memory_db);
            app.manage(memory::CandidateCache::default());
            app.manage(typing_activity::TypingActivityState::new(app.handle()));

            configure_tray(app)?;
            configure_global_shortcut(app)?;
            app.state::<PluginRegistry>()
                .register_declarative_plugins(app.handle());
            let settings = read_settings(app.handle());
            persist_settings(app.handle(), &settings)?;
            if let Ok(mut paused) = app
                .state::<app_awareness::ForegroundAppState>()
                .sensing_paused
                .lock()
            {
                *paused = settings.sensing_paused;
            }
            if !settings.onboarding_completed {
                show_and_focus(app.handle(), "panel");
            }
            restore_pet_position(app.handle());
            show_pet_on_startup(app.handle());
            watch_pet_position(app.handle());
            restore_bubble_size(app.handle());
            watch_bubble_resize(app.handle());
            watch_panel_close(app.handle());
            enable_pet_background_drag(app.handle());
            enable_bubble_background_drag(app.handle());
            watch_reminders(app.handle());
            watch_calendar_events(app.handle());
            watch_focus_timer(app.handle());
            watch_ambient_nudges(app.handle());
            watch_idle_detection(app.handle());
            watch_foreground_app(app.handle());
            typing_activity::start_keyboard_monitor(app.handle());
            typing_activity::watch_typing_rollover(app.handle());
            watch_work_rhythm(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            show_bubble,
            hide_bubble,
            toggle_bubble,
            open_panel,
            toggle_panel,
            show_pet,
            hide_pet,
            begin_screen_capture,
            cancel_screen_capture,
            confirm_screen_capture,
            get_screen_capture_preview,
            clear_screen_capture,
            move_pet,
            move_pet_relative,
            get_pet_position,
            get_settings,
            screen_capture_permission_status,
            check_for_updates,
            check_for_updates_extended,
            list_chat_history,
            clear_chat_history,
            clear_chat_context,
            speak_local_text,
            stop_local_speech,
            get_focus_state,
            get_typing_stats_today,
            get_work_rhythm_state,
            start_focus,
            start_break,
            pause_focus,
            resume_focus,
            stop_focus,
            list_reminders,
            create_reminder,
            delete_reminder,
            list_memos,
            create_memo,
            update_memo,
            delete_memo,
            summarize_memos,
            list_calendar_events,
            create_calendar_event,
            delete_calendar_event,
            export_calendar_events,
            open_calendar_import,
            list_business_plugins,
            list_external_plugins,
            list_provider_tools,
            confirm_chat_action,
            reject_chat_action,
            prepare_text_attachment,
            clear_text_attachment,
            save_generated_text,
            update_quiet_mode,
            update_preferences,
            update_work_rhythm_preferences,
            update_ai_settings,
            get_speech_model_status,
            download_speech_model,
            transcribe_voice_input,
            update_html_preview_enabled,
            generate_pet_companion_response,
            list_models,
            chat::chat_start,
            chat::chat_cancel,
            get_bubble_chat_history,
            get_onboarding_status,
            complete_onboarding,
            skip_onboarding,
            reset_onboarding,
            get_foreground_app_state,
            toggle_foreground_sensing,
            export_data,
            export_to_file,
            preview_import,
            import_data,
            get_calendar_sync_status,
            sync_calendar_to_system,
            sync_calendar_from_system,
            download_update_asset,
            // Memory system (Phase 1)
            memory::list_memories,
            memory::get_memory_detail,
            memory::create_memory,
            memory::update_memory,
            memory::delete_memory,
            memory::clear_memories,
            // Memory system (Phase 2: retrieval & management)
            memory::search_memories,
            memory::search_related_memories,
            memory::get_recent_memories,
            memory::build_memory_context,
            memory::pin_memory,
            memory::unpin_memory,
            memory::feedback_memory,
            memory::add_memory_relation,
            memory::remove_memory_relation,
            memory::get_memory_relations,
            // Memory system (Phase 3+: writer, reflection, maintenance, import/export)
            memory::capture_memory_candidates,
            memory::get_pending_candidates,
            memory::apply_memory_candidates,
            memory::reject_memory_candidate,
            memory::reflect_memory_now,
            memory::get_memory_summaries,
            memory::merge_memories_cmd,
            memory::get_merge_candidates,
            memory::abstract_semantic_from_events,
            memory::expire_old_memories,
            memory::recalculate_confidence,
            memory::export_memories,
            memory::memory_preview_import,
            memory::import_memories
        ])
        .run(tauri::generate_context!())
        .expect("error while running Piko desktop application");
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use super::CaptureSelection;
    use super::{
        action_draft_from_tool_call, append_provider_tool_results, append_provider_tools,
        append_session_chat_history, build_attachment_prompt, calendar_conflict_note,
        calendar_delete_batch_input_from_value, calendar_event_batch_input_from_value,
        calendar_event_input_from_value, chat_request_body, chat_url, clamp_pet_position,
        coalesce_calendar_delete_calls, collect_due_reminders,
        create_calendar_event_record_at_path, decode_openai_tool_calls,
        delete_calendar_event_batch_record_at_path, extract_chat_deltas, extract_model_ids,
        find_calendar_conflicts, idle_threshold_seconds,
        looks_like_unconfirmed_local_action_response, models_url, monitor_contains,
        next_idle_state, next_repeat_due, normalize_base_url, parse_data_url,
        prompt_requests_local_action, provider_tools, read_calendar_events_from_path,
        read_text_attachment, render_icalendar, should_bypass_system_proxy, system_prompt,
        text_for_speech, today_focus_minutes, update_anthropic_tool_calls,
        update_gemini_tool_calls, update_openai_tool_calls, validate_ai_settings,
        validate_declarative_plugin, validate_save_path, version_parts, AiSettings, AppSettings,
        CalendarEvent, ChatEvent, ChatHistoryEntry, DeclarativePluginPackage, FocusRecord,
        OpenAiToolCallAccumulator, PluginManifest, PluginRegistry, PluginToolManifest, Reminder,
        ScreenCapture, TextAttachment, ToolCall,
    };
    use chrono::{Duration as ChronoDuration, Local, TimeZone};
    use std::{
        collections::HashSet,
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };
    use tauri::{LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize};

    #[test]
    fn detects_a_position_inside_monitor_bounds() {
        assert!(monitor_contains(
            PhysicalPosition::new(100, 200),
            PhysicalSize::new(1920, 1080),
            PhysicalPosition::new(110, 210),
        ));
    }

    #[test]
    fn rejects_a_position_outside_monitor_bounds() {
        assert!(!monitor_contains(
            PhysicalPosition::new(100, 200),
            PhysicalSize::new(1920, 1080),
            PhysicalPosition::new(99, 210),
        ));
    }

    #[test]
    fn clamps_pet_position_to_keep_a_visible_edge() {
        let clamped = clamp_pet_position(
            LogicalPosition::new(-300.0, 1200.0),
            LogicalSize::new(156.0, 156.0),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1440.0, 900.0),
        );

        assert_eq!(clamped, LogicalPosition::new(-116.0, 860.0));
    }

    #[test]
    fn removes_emoji_components_before_local_speech() {
        assert_eq!(
            text_for_speech("完成啦 🎉 继续处理 👩🏽‍💻，保留中文和标点。"),
            "完成啦  继续处理 ，保留中文和标点。"
        );
    }

    #[test]
    fn validates_generated_text_save_extensions() {
        assert!(validate_save_path(PathBuf::from("answer.md").as_path()).is_ok());
        assert!(validate_save_path(PathBuf::from("script.rs").as_path()).is_ok());
        assert!(validate_save_path(PathBuf::from("archive.zip").as_path()).is_err());
        assert!(validate_save_path(PathBuf::from("README").as_path()).is_err());
    }

    #[test]
    fn sums_only_today_completed_focus_minutes() {
        let records = vec![
            FocusRecord {
                completed_at: 86_400,
                minutes: 25,
            },
            FocusRecord {
                completed_at: 86_500,
                minutes: 15,
            },
            FocusRecord {
                completed_at: 172_800,
                minutes: 60,
            },
        ];

        assert_eq!(today_focus_minutes(&records, 86_600), 40);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn keeps_macos_capture_coordinates_in_core_graphics_points() {
        assert_eq!(
            super::capture_area_coordinates(
                PhysicalPosition::new(100, 200),
                &CaptureSelection {
                    x: 10.0,
                    y: 20.0,
                    width: 300.0,
                    height: 160.0,
                },
                2.0,
            ),
            (110, 220, 300, 160),
        );
    }

    #[test]
    fn defaults_to_balanced_quiet_mode() {
        let settings = AppSettings::default();
        assert_eq!(settings.quiet_mode, "balanced");
        assert_eq!(settings.companion_name, "Piko");
        assert_eq!(settings.theme, "sage");
        assert!(!settings.sensing_paused);
        assert!(settings.break_reminders_enabled);
        assert_eq!(settings.break_reminder_interval_minutes, 45);
        assert_eq!(settings.break_reminder_cooldown_minutes, 30);
        assert!(!settings.break_reminder_quiet_hours_enabled);
        assert_eq!(settings.break_reminder_quiet_hours_start, "22:00");
        assert_eq!(settings.break_reminder_quiet_hours_end, "08:00");
    }

    #[test]
    fn uses_quiet_mode_specific_idle_thresholds() {
        assert_eq!(idle_threshold_seconds("active"), 60);
        assert_eq!(idle_threshold_seconds("balanced"), 120);
        assert_eq!(idle_threshold_seconds("minimal"), 300);
    }

    #[test]
    fn detects_quiet_hours_across_midnight() {
        let late_night = Local
            .with_ymd_and_hms(2026, 1, 1, 23, 0, 0)
            .single()
            .expect("valid local time")
            .timestamp() as u64;
        let early_morning = Local
            .with_ymd_and_hms(2026, 1, 2, 7, 0, 0)
            .single()
            .expect("valid local time")
            .timestamp() as u64;
        let noon = Local
            .with_ymd_and_hms(2026, 1, 2, 12, 0, 0)
            .single()
            .expect("valid local time")
            .timestamp() as u64;

        assert!(super::is_within_quiet_hours(
            "22:00", "08:00", true, late_night
        ));
        assert!(super::is_within_quiet_hours(
            "22:00",
            "08:00",
            true,
            early_morning
        ));
        assert!(!super::is_within_quiet_hours("22:00", "08:00", true, noon));
        assert!(!super::is_within_quiet_hours(
            "22:00", "08:00", false, late_night
        ));
    }

    #[test]
    fn starts_and_ends_idle_rest_without_recording_input() {
        let settings = AppSettings::default();
        let (is_idle, event) = next_idle_state(false, &settings, 120, false);
        assert!(is_idle);
        assert!(matches!(event, Some(super::PetVisualEvent::IdleStarted)));

        let (is_idle, event) = next_idle_state(is_idle, &settings, 0, false);
        assert!(!is_idle);
        assert!(matches!(event, Some(super::PetVisualEvent::IdleEnded)));
    }

    #[test]
    fn calendar_event_notices_fire_once_near_start_time() {
        let events = vec![
            CalendarEvent {
                id: "soon".to_string(),
                title: "站会".to_string(),
                start_at: 100,
                end_at: 160,
                location: None,
                notes: None,
            },
            CalendarEvent {
                id: "old".to_string(),
                title: "旧日程".to_string(),
                start_at: 30,
                end_at: 40,
                location: None,
                notes: None,
            },
            CalendarEvent {
                id: "future".to_string(),
                title: "稍后".to_string(),
                start_at: 130,
                end_at: 160,
                location: None,
                notes: None,
            },
        ];
        let mut notified = HashSet::new();

        let due = super::collect_due_calendar_events(&events, 110, &mut notified);
        let repeated = super::collect_due_calendar_events(&events, 111, &mut notified);

        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, "soon");
        assert!(repeated.is_empty());
    }

    #[test]
    fn suppresses_idle_rest_while_sensing_is_paused_or_piko_is_busy() {
        let mut settings = AppSettings {
            sensing_paused: true,
            ..Default::default()
        };
        assert!(!next_idle_state(false, &settings, 120, false).0);

        settings.sensing_paused = false;
        assert!(!next_idle_state(false, &settings, 120, true).0);
    }

    #[test]
    fn normalizes_base_url() {
        assert_eq!(
            normalize_base_url(" http://localhost:11434/v1/ "),
            "http://localhost:11434/v1"
        );
    }

    #[test]
    fn compares_release_version_parts() {
        assert!(version_parts("v0.2.0") > version_parts("0.1.9"));
        assert_eq!(version_parts("v1.0.0"), vec![1, 0, 0]);
    }

    #[test]
    fn extracts_openai_compatible_chat_delta() {
        assert_eq!(
            extract_chat_deltas(
                "openai-compatible",
                r#"data: {"choices":[{"delta":{"content":"你好"}}]}"#
            ),
            vec!["你好".to_string()]
        );
        assert!(extract_chat_deltas("openai-compatible", "data: [DONE]").is_empty());
    }

    #[test]
    fn lmstudio_uses_openai_compatible_protocol() {
        let ai = AiSettings {
            provider: "lmstudio".to_string(),
            base_url: "http://localhost:1234/v1".to_string(),
            model: "llama-3.2-1b".to_string(),
            ..Default::default()
        };
        // LM Studio uses the same chat completions endpoint as OpenAI
        assert_eq!(
            chat_url(&ai).unwrap(),
            "http://localhost:1234/v1/chat/completions"
        );
        // LM Studio uses the same models listing endpoint
        assert_eq!(models_url(&ai), "http://localhost:1234/v1/models");
        // LM Studio model list response uses OpenAI-compatible "data" array
        assert_eq!(
            extract_model_ids(
                "lmstudio",
                &serde_json::json!({ "data": [{ "id": "llama-3.2-1b" }, { "id": "qwen2.5-7b" }] })
            ),
            vec!["llama-3.2-1b".to_string(), "qwen2.5-7b".to_string()]
        );
        // LM Studio streaming deltas use the same format as OpenAI
        assert_eq!(
            extract_chat_deltas(
                "lmstudio",
                r#"data: {"choices":[{"delta":{"content":"Hello from LM Studio"}}]}"#
            ),
            vec!["Hello from LM Studio".to_string()]
        );
        assert!(extract_chat_deltas("lmstudio", "data: [DONE]").is_empty());
        // LM Studio localhost should bypass system proxy
        assert!(should_bypass_system_proxy("http://localhost:1234/v1"));
    }

    #[test]
    fn lmstudio_builds_openai_compatible_chat_request_body() {
        let settings = AppSettings {
            ai: AiSettings {
                provider: "lmstudio".to_string(),
                base_url: "http://localhost:1234/v1".to_string(),
                model: "llama-3.2-1b".to_string(),
                temperature: 0.5,
                ..Default::default()
            },
            ..Default::default()
        };
        let body = chat_request_body(&settings, &[], "你好", None, None).unwrap();
        // Same structure as OpenAI-compatible providers
        assert_eq!(body["model"], "llama-3.2-1b");
        assert_eq!(body["temperature"], 0.5);
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][1]["role"], "user");
        assert_eq!(body["messages"][1]["content"], "你好");
    }

    #[test]
    fn lmstudio_allows_empty_model_for_auto_detection() {
        // LM Studio auto-selects the currently loaded model when model is empty
        let settings = AiSettings {
            provider: "lmstudio".to_string(),
            base_url: "http://localhost:1234/v1".to_string(),
            model: "".to_string(),
            ..Default::default()
        };
        assert!(validate_ai_settings(&settings).is_ok());

        let openai_compatible = AiSettings {
            provider: "openai-compatible".to_string(),
            base_url: "http://localhost:11434/v1".to_string(),
            model: "".to_string(),
            ..Default::default()
        };
        assert!(validate_ai_settings(&openai_compatible).is_ok());

        // Cloud providers still require a model name
        let anthropic = AiSettings {
            provider: "anthropic".to_string(),
            base_url: "https://api.anthropic.com/v1".to_string(),
            model: "".to_string(),
            ..Default::default()
        };
        assert!(validate_ai_settings(&anthropic).is_err());

        // LM Studio with empty model should still build a valid request body
        let app_settings = AppSettings {
            ai: settings,
            ..Default::default()
        };
        let body = chat_request_body(&app_settings, &[], "你好", None, None).unwrap();
        assert_eq!(body["model"], "");
    }

    #[test]
    fn extracts_anthropic_and_gemini_chat_deltas() {
        assert_eq!(
            extract_chat_deltas(
                "anthropic",
                r#"data: {"delta":{"type":"text_delta","text":"你好"}}"#
            ),
            vec!["你好".to_string()]
        );
        assert_eq!(
            extract_chat_deltas(
                "gemini",
                r#"data: {"candidates":[{"content":{"parts":[{"text":"你"},{"text":"好"}]}}]}"#
            ),
            vec!["你".to_string(), "好".to_string()]
        );
    }

    #[test]
    fn builds_provider_specific_urls_and_model_lists() {
        let mut ai = AiSettings {
            provider: "anthropic".to_string(),
            base_url: "https://api.anthropic.com/v1".to_string(),
            ..Default::default()
        };
        assert_eq!(
            chat_url(&ai).unwrap(),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            extract_model_ids(
                "anthropic",
                &serde_json::json!({ "data": [{ "id": "claude" }] })
            ),
            vec!["claude".to_string()]
        );

        ai.provider = "gemini".to_string();
        ai.base_url = "https://generativelanguage.googleapis.com/v1beta".to_string();
        ai.model = "models/gemini-test".to_string();
        assert_eq!(
            chat_url(&ai).unwrap(),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse"
        );
        assert_eq!(
            extract_model_ids(
                "gemini",
                &serde_json::json!({ "models": [{ "name": "models/gemini-test" }] })
            ),
            vec!["gemini-test".to_string()]
        );
    }

    #[test]
    fn builds_anthropic_and_gemini_multimodal_payloads() {
        let capture = ScreenCapture {
            data_url: "data:image/png;base64,cG5n".to_string(),
            width: 1,
            height: 1,
        };
        assert_eq!(
            parse_data_url(&capture.data_url).unwrap(),
            ("image/png", "cG5n")
        );

        let mut settings = AppSettings::default();
        settings.ai.provider = "anthropic".to_string();
        let anthropic = chat_request_body(&settings, &[], "看图", Some(&capture), None).unwrap();
        assert_eq!(
            anthropic["messages"][0]["content"][1]["source"]["data"],
            "cG5n"
        );

        settings.ai.provider = "gemini".to_string();
        let gemini = chat_request_body(&settings, &[], "看图", Some(&capture), None).unwrap();
        assert_eq!(
            gemini["contents"][0]["parts"][1]["inlineData"]["mimeType"],
            "image/png"
        );
    }

    #[test]
    fn bypasses_system_proxy_for_local_model_services() {
        assert!(should_bypass_system_proxy("http://localhost:11434/v1"));
        assert!(should_bypass_system_proxy("http://127.0.0.1:1234/v1"));
        assert!(should_bypass_system_proxy("http://[::1]:8000/v1"));
        assert!(should_bypass_system_proxy(
            "http://model-server.local:8000/v1"
        ));
        assert!(!should_bypass_system_proxy("https://api.example.com/v1"));
    }

    #[test]
    fn serializes_single_word_chat_event_types() {
        let json = serde_json::to_value(ChatEvent::Completed {
            request_id: "request-1".to_string(),
        })
        .expect("chat event should serialize");

        assert_eq!(json["type"], "completed");
        assert_eq!(json["requestId"], "request-1");
    }

    #[test]
    fn serializes_action_proposed_chat_events_for_the_bubble_listener() {
        let json = serde_json::to_value(ChatEvent::ActionProposed {
            request_id: "request-1".to_string(),
            draft: super::ActionDraft {
                id: "draft-1".to_string(),
                plugin_id: "piko.calendar".to_string(),
                tool_name: "create_event".to_string(),
                summary: "创建日程".to_string(),
                arguments: serde_json::json!({}),
                created_at: 1,
            },
        })
        .expect("chat event should serialize");

        assert_eq!(json["type"], "action-proposed");
        assert_eq!(json["requestId"], "request-1");
        assert_eq!(json["draft"]["createdAt"], 1);
    }

    #[test]
    fn system_prompt_mentions_reminder_and_calendar_lookup_for_deletion() {
        let prompt = system_prompt("Piko", None);
        assert!(prompt.contains("查询提醒时优先调用 list_reminders"));
        assert!(prompt.contains("查询、删除或定位日程时优先调用 list_events"));
        assert!(prompt.contains("删除提醒或日程前"));
        assert!(prompt.contains("删除多个或全部日程时必须使用 delete_event_batch"));
    }

    #[test]
    fn detects_local_action_requests_that_require_tools() {
        assert!(prompt_requests_local_action("帮我创建明天下午 3 点的日程"));
        assert!(prompt_requests_local_action("delete this calendar event"));
        assert!(prompt_requests_local_action("设置一个喝水提醒"));
        assert!(prompt_requests_local_action("帮我记一下备忘：买牛奶"));
        assert!(prompt_requests_local_action("添加备忘：周五提交报告"));
        assert!(!prompt_requests_local_action("解释一下怎么规划日程"));
        assert!(!prompt_requests_local_action("今天适合做什么"));
    }

    #[test]
    fn detects_unconfirmed_local_action_success_claims() {
        assert!(looks_like_unconfirmed_local_action_response(
            "已成功创建日程：项目评审"
        ));
        assert!(looks_like_unconfirmed_local_action_response(
            "Reminder deleted successfully."
        ));
        assert!(looks_like_unconfirmed_local_action_response(
            "好的，我已经帮你记到备忘录了 ✅"
        ));
        assert!(looks_like_unconfirmed_local_action_response(
            "已创建备忘：买牛奶"
        ));
        assert!(!looks_like_unconfirmed_local_action_response(
            "我可以帮你创建日程，但需要先确认。"
        ));
        assert!(!looks_like_unconfirmed_local_action_response(
            "这是一个普通回答。"
        ));
    }

    #[test]
    fn prepares_a_text_attachment_preview_without_exposing_its_path() {
        let path = temp_attachment_path("md");
        fs::write(&path, "第一行\n第二行").expect("fixture should be writable");

        let (attachment, preview) =
            read_text_attachment(&path).expect("markdown attachment should be accepted");

        assert_eq!(attachment.content, "第一行\n第二行");
        assert_eq!(
            preview.display_name,
            path.file_name().unwrap().to_string_lossy()
        );
        assert_eq!(preview.char_count, 7);
        assert!(!preview
            .preview
            .contains(path.parent().unwrap().to_string_lossy().as_ref()));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_an_unsupported_attachment_extension() {
        let path = temp_attachment_path("png");
        fs::write(&path, "not really an image").expect("fixture should be writable");

        assert!(read_text_attachment(&path).is_err());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_an_attachment_larger_than_one_mibibyte() {
        let path = temp_attachment_path("txt");
        fs::write(&path, vec![b'a'; 1024 * 1024 + 1]).expect("fixture should be writable");

        assert!(read_text_attachment(&path).is_err());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn requires_an_explicit_action_before_including_attachment_content() {
        let attachment = TextAttachment {
            display_name: "notes.md".to_string(),
            content: "private body".to_string(),
        };

        let (plain_prompt, _) =
            build_attachment_prompt("hello", None, Some(&attachment)).expect("plain chat works");
        assert_eq!(plain_prompt, "hello");

        let (attachment_prompt, history_prompt) =
            build_attachment_prompt("", Some("summarize"), Some(&attachment))
                .expect("confirmed attachment action works");
        assert!(attachment_prompt.contains("private body"));
        assert_eq!(history_prompt, "[附件总结] notes.md");
    }

    #[test]
    fn triggers_only_due_pending_reminders_once() {
        let mut reminders = vec![
            Reminder {
                id: "due".to_string(),
                title: "到期".to_string(),
                due_at: 9,
                status: "pending".to_string(),
                repeat: "none".to_string(),
            },
            Reminder {
                id: "future".to_string(),
                title: "稍后".to_string(),
                due_at: 11,
                status: "pending".to_string(),
                repeat: "none".to_string(),
            },
            Reminder {
                id: "done".to_string(),
                title: "完成".to_string(),
                due_at: 8,
                status: "triggered".to_string(),
                repeat: "none".to_string(),
            },
        ];

        let due = collect_due_reminders(&mut reminders, 10);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, "due");
        assert_eq!(reminders[0].status, "triggered");
        assert!(collect_due_reminders(&mut reminders, 10).is_empty());
    }

    #[test]
    fn reschedules_repeating_reminders_after_triggering() {
        let mut reminders = vec![Reminder {
            id: "daily".to_string(),
            title: "每日提醒".to_string(),
            due_at: 9,
            status: "pending".to_string(),
            repeat: "daily".to_string(),
        }];

        let due = collect_due_reminders(&mut reminders, 10);
        assert_eq!(due.len(), 1);
        assert_eq!(reminders[0].status, "pending");
        assert!(reminders[0].due_at > 10);
        assert!(collect_due_reminders(&mut reminders, 10).is_empty());
    }

    #[test]
    fn registers_the_builtin_business_plugins() {
        let manifests = PluginRegistry::with_builtin_plugins().manifests();
        assert_eq!(manifests.len(), 3);
        assert_eq!(manifests[0].id, "piko.calendar");
        assert_eq!(manifests[1].id, "piko.memos");
        assert_eq!(manifests[2].id, "piko.reminders");
        assert_eq!(manifests[0].tools[0].name, "list_events");
        assert_eq!(manifests[0].tools[4].name, "delete_event");
        assert_eq!(manifests[0].tools[5].name, "delete_event_batch");
        assert_eq!(manifests[0].tools[5].risk, "sensitive");
        assert_eq!(manifests[0].tools[5].confirmation, "always");
        assert_eq!(manifests[1].tools[0].name, "list_memos");
        assert_eq!(manifests[1].tools[1].name, "create_memo");
        assert_eq!(manifests[1].tools[1].risk, "write");
        assert_eq!(manifests[1].tools[1].confirmation, "always");
        assert_eq!(manifests[2].tools[0].name, "list_reminders");
        assert_eq!(manifests[2].tools[2].name, "delete_reminder");
        assert_eq!(manifests[2].tools[1].risk, "write");
        assert_eq!(manifests[2].tools[2].risk, "sensitive");
        assert_eq!(manifests[2].tools[2].confirmation, "always");
    }

    #[test]
    fn overlapping_calendar_events_are_created_with_a_hint() {
        let path = temp_calendar_events_path();
        let now = Local::now() + ChronoDuration::days(1);
        let first = calendar_event_input_from_value(&serde_json::json!({
            "title": "已有日程",
            "startAt": (now + ChronoDuration::hours(1)).timestamp() as u64,
            "endAt": (now + ChronoDuration::hours(2)).timestamp() as u64,
        }))
        .unwrap();
        let second = calendar_event_input_from_value(&serde_json::json!({
            "title": "抢购手机",
            "startAt": (now + ChronoDuration::hours(1) + ChronoDuration::minutes(30)).timestamp() as u64,
            "endAt": (now + ChronoDuration::hours(2) + ChronoDuration::minutes(30)).timestamp() as u64,
        }))
        .unwrap();

        let created_first = create_calendar_event_record_at_path(&path, first).unwrap();
        let created_second = create_calendar_event_record_at_path(&path, second).unwrap();
        let queried = read_calendar_events_from_path(&path);

        assert_eq!(queried.len(), 2);
        assert_eq!(created_first.title, "已有日程");
        assert_eq!(created_second.title, "抢购手机");
        assert!(calendar_conflict_note(
            &queried[..1],
            created_second.start_at,
            created_second.end_at
        )
        .is_some());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn calendar_conflicts_exclude_touching_boundaries() {
        let events = vec![CalendarEvent {
            id: "one".to_string(),
            title: "已有日程".to_string(),
            start_at: 100,
            end_at: 200,
            location: None,
            notes: None,
        }];

        assert_eq!(find_calendar_conflicts(&events, 150, 250).len(), 1);
        assert!(find_calendar_conflicts(&events, 200, 300).is_empty());
    }

    #[test]
    fn deletes_a_batch_of_calendar_events_atomically() {
        let path = temp_calendar_events_path();
        let now = Local::now() + ChronoDuration::days(1);
        let first = create_calendar_event_record_at_path(
            &path,
            calendar_event_input_from_value(&serde_json::json!({
                "title": "日程一",
                "startAt": (now + ChronoDuration::hours(1)).timestamp() as u64,
                "endAt": (now + ChronoDuration::hours(2)).timestamp() as u64,
            }))
            .unwrap(),
        )
        .unwrap();
        let second = create_calendar_event_record_at_path(
            &path,
            calendar_event_input_from_value(&serde_json::json!({
                "title": "日程二",
                "startAt": (now + ChronoDuration::hours(3)).timestamp() as u64,
                "endAt": (now + ChronoDuration::hours(4)).timestamp() as u64,
            }))
            .unwrap(),
        )
        .unwrap();

        let deleted = delete_calendar_event_batch_record_at_path(
            &path,
            calendar_delete_batch_input_from_value(&serde_json::json!({
                "events": [{ "id": first.id }, { "id": second.id }]
            }))
            .unwrap(),
        )
        .unwrap();

        assert_eq!(deleted.len(), 2);
        assert!(read_calendar_events_from_path(&path).is_empty());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn keeps_calendar_events_when_a_batch_delete_target_is_missing() {
        let path = temp_calendar_events_path();
        let now = Local::now() + ChronoDuration::days(1);
        let existing = create_calendar_event_record_at_path(
            &path,
            calendar_event_input_from_value(&serde_json::json!({
                "title": "仍需保留",
                "startAt": (now + ChronoDuration::hours(1)).timestamp() as u64,
                "endAt": (now + ChronoDuration::hours(2)).timestamp() as u64,
            }))
            .unwrap(),
        )
        .unwrap();

        let result = delete_calendar_event_batch_record_at_path(
            &path,
            calendar_delete_batch_input_from_value(&serde_json::json!({
                "events": [{ "id": existing.id }, { "id": "missing-event" }]
            }))
            .unwrap(),
        );

        assert!(result.is_err());
        assert_eq!(read_calendar_events_from_path(&path).len(), 1);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn maps_plugin_tools_to_provider_specific_schemas() {
        let manifests = PluginRegistry::with_builtin_plugins().manifests();
        let openai = provider_tools("openai-compatible", &manifests);
        let anthropic = provider_tools("anthropic", &manifests);
        let gemini = provider_tools("gemini", &manifests);

        assert_eq!(openai[0]["type"], "function");
        assert!(openai[0]["function"]["name"]
            .as_str()
            .unwrap()
            .contains("__"));
        assert!(anthropic[0]["input_schema"].is_object());
        assert!(gemini[0]["functionDeclarations"].is_array());
    }

    #[test]
    fn injects_tools_for_all_native_tool_use_providers() {
        let manifests = PluginRegistry::with_builtin_plugins().manifests();
        let mut openai = serde_json::json!({ "messages": [] });
        let mut anthropic = serde_json::json!({ "messages": [] });
        let mut gemini = serde_json::json!({ "contents": [] });

        append_provider_tools(&mut openai, "openai-compatible", &manifests);
        append_provider_tools(&mut anthropic, "anthropic", &manifests);
        append_provider_tools(&mut gemini, "gemini", &manifests);

        assert!(openai["tools"].is_array());
        assert!(anthropic["tools"].is_array());
        assert!(gemini["tools"][0]["functionDeclarations"].is_array());
    }

    #[test]
    fn aggregates_and_decodes_openai_streaming_tool_calls() {
        let mut calls = Vec::<OpenAiToolCallAccumulator>::new();
        update_openai_tool_calls(
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"piko_calendar__create_event","arguments":"{\"title\":\"评审\","}}]}}]}"#,
            &mut calls,
        );
        update_openai_tool_calls(
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"startAt\":100,\"endAt\":200}"}}]}}]}"#,
            &mut calls,
        );

        let decoded =
            decode_openai_tool_calls(&PluginRegistry::with_builtin_plugins(), calls).unwrap();
        assert_eq!(decoded[0].0, "call-1");
        assert_eq!(decoded[0].1.plugin_id, "piko.calendar");
        assert_eq!(decoded[0].1.tool_name, "create_event");
        assert_eq!(decoded[0].1.arguments["title"], "评审");
    }

    #[test]
    fn coalesces_multiple_calendar_delete_calls_into_one_batch() {
        let calls = vec![
            (
                "call-1".to_string(),
                ToolCall {
                    plugin_id: "piko.calendar".to_string(),
                    tool_name: "delete_event".to_string(),
                    arguments: serde_json::json!({ "id": "event-1", "title": "日程一" }),
                },
            ),
            (
                "call-2".to_string(),
                ToolCall {
                    plugin_id: "piko.calendar".to_string(),
                    tool_name: "delete_event".to_string(),
                    arguments: serde_json::json!({ "id": "event-2", "title": "日程二" }),
                },
            ),
        ];

        let coalesced = coalesce_calendar_delete_calls(calls);

        assert_eq!(coalesced.len(), 1);
        assert_eq!(coalesced[0].1.tool_name, "delete_event_batch");
        assert_eq!(
            coalesced[0].1.arguments["events"].as_array().unwrap().len(),
            2
        );
    }

    #[test]
    fn creates_confirmation_drafts_for_model_write_tools() {
        let now = Local
            .with_ymd_and_hms(2026, 6, 1, 10, 0, 0)
            .single()
            .unwrap();
        let draft = action_draft_from_tool_call(
            &super::ToolCall {
                plugin_id: "piko.calendar".to_string(),
                tool_name: "create_event".to_string(),
                arguments: serde_json::json!({
                    "title": "项目评审",
                    "startAt": "2026-06-01T11:00:00+08:00",
                    "endAt": "2026-06-01T12:00:00+08:00",
                }),
            },
            now,
        )
        .unwrap();

        assert_eq!(draft.plugin_id, "piko.calendar");
        assert!(draft.summary.contains("项目评审"));
        assert!(draft.summary.contains("2026-06-01 11:00"));
    }

    #[test]
    fn creates_confirmation_drafts_for_deletions() {
        let now = Local
            .with_ymd_and_hms(2026, 6, 1, 10, 0, 0)
            .single()
            .unwrap();
        let reminder_draft = action_draft_from_tool_call(
            &super::ToolCall {
                plugin_id: "piko.reminders".to_string(),
                tool_name: "delete_reminder".to_string(),
                arguments: serde_json::json!({
                    "id": "reminder-1",
                    "title": "提交周报",
                    "dueAt": "2026-06-01T18:00:00+08:00",
                    "repeat": "none",
                }),
            },
            now,
        )
        .unwrap();
        let calendar_draft = action_draft_from_tool_call(
            &super::ToolCall {
                plugin_id: "piko.calendar".to_string(),
                tool_name: "delete_event".to_string(),
                arguments: serde_json::json!({
                    "id": "event-1",
                    "title": "项目评审",
                    "startAt": "2026-06-01T11:00:00+08:00",
                    "endAt": "2026-06-01T12:00:00+08:00",
                }),
            },
            now,
        )
        .unwrap();

        assert_eq!(reminder_draft.tool_name, "delete_reminder");
        assert!(reminder_draft.summary.contains("提交周报"));
        assert!(reminder_draft.summary.contains("2026-06-01 18:00"));
        assert_eq!(calendar_draft.tool_name, "delete_event");
        assert!(calendar_draft.summary.contains("项目评审"));
        assert!(calendar_draft.summary.contains("2026-06-01 11:00"));
    }

    #[test]
    fn normalizes_iso_calendar_tool_timestamps() {
        let input = calendar_event_input_from_value(&serde_json::json!({
            "title": "项目评审",
            "startAt": "2026-06-02T15:00:00+08:00",
            "endAt": "2026-06-02T16:00:00+08:00",
        }))
        .unwrap();

        assert_eq!(
            input.start_at,
            chrono::DateTime::parse_from_rfc3339("2026-06-02T15:00:00+08:00")
                .unwrap()
                .timestamp() as u64
        );
        assert_eq!(
            input.end_at,
            chrono::DateTime::parse_from_rfc3339("2026-06-02T16:00:00+08:00")
                .unwrap()
                .timestamp() as u64
        );
    }

    #[test]
    fn aggregates_anthropic_and_gemini_tool_calls() {
        let mut anthropic = Vec::new();
        update_anthropic_tool_calls(
            r#"data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool-1","name":"piko_calendar__list_events","input":{}}}"#,
            &mut anthropic,
        );
        let decoded =
            decode_openai_tool_calls(&PluginRegistry::with_builtin_plugins(), anthropic).unwrap();
        assert_eq!(decoded[0].0, "tool-1");
        assert_eq!(decoded[0].1.tool_name, "list_events");

        let mut gemini = Vec::new();
        update_gemini_tool_calls(
            r#"data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"piko_calendar__list_events","args":{}}}]}}]}"#,
            &mut gemini,
        );
        let decoded =
            decode_openai_tool_calls(&PluginRegistry::with_builtin_plugins(), gemini).unwrap();
        assert_eq!(decoded[0].1.tool_name, "list_events");
    }

    #[test]
    fn appends_provider_specific_tool_results() {
        let call = ToolCall {
            plugin_id: "piko.calendar".to_string(),
            tool_name: "list_events".to_string(),
            arguments: serde_json::json!({}),
        };
        let calls = vec![("call-1".to_string(), call, serde_json::json!([]))];
        let mut anthropic = serde_json::json!({ "messages": [] });
        append_provider_tool_results(&mut anthropic, "anthropic", &calls).unwrap();
        assert_eq!(anthropic["messages"][0]["content"][0]["type"], "tool_use");
        assert_eq!(
            anthropic["messages"][1]["content"][0]["type"],
            "tool_result"
        );

        let mut gemini = serde_json::json!({ "contents": [] });
        append_provider_tool_results(&mut gemini, "gemini", &calls).unwrap();
        assert!(gemini["contents"][0]["parts"][0]["functionCall"].is_object());
        assert!(gemini["contents"][1]["parts"][0]["functionResponse"].is_object());
    }

    #[test]
    fn builds_batch_calendar_confirmation_drafts() {
        let batch = serde_json::json!({
            "events": [
                {
                    "title": "学习一",
                    "startAt": "2026-06-02T15:00:00+08:00",
                    "endAt": "2026-06-02T16:00:00+08:00"
                },
                {
                    "title": "学习二",
                    "startAt": "2026-06-03T15:00:00+08:00",
                    "endAt": "2026-06-03T16:00:00+08:00"
                }
            ]
        });
        assert_eq!(
            calendar_event_batch_input_from_value(&batch)
                .unwrap()
                .events
                .len(),
            2
        );
        let draft = action_draft_from_tool_call(
            &ToolCall {
                plugin_id: "piko.calendar".to_string(),
                tool_name: "create_event_batch".to_string(),
                arguments: batch,
            },
            Local::now(),
        )
        .unwrap();
        assert!(draft.summary.contains("批量创建 2 条日程"));
    }

    #[test]
    fn builds_batch_calendar_delete_confirmation_drafts() {
        let draft = action_draft_from_tool_call(
            &ToolCall {
                plugin_id: "piko.calendar".to_string(),
                tool_name: "delete_event_batch".to_string(),
                arguments: serde_json::json!({
                    "events": [
                        { "id": "event-1", "title": "日程一" },
                        { "id": "event-2", "title": "日程二" }
                    ]
                }),
            },
            Local::now(),
        )
        .unwrap();

        assert!(draft.summary.contains("批量删除 2 条日程"));
        assert!(draft.summary.contains("日程一"));
        assert!(draft.summary.contains("日程二"));
    }

    #[test]
    fn renders_icalendar_with_escaped_text() {
        let calendar = render_icalendar(&[CalendarEvent {
            id: "one".to_string(),
            title: "评审,同步".to_string(),
            start_at: 1_780_384_400,
            end_at: 1_780_388_000,
            location: Some("会议室;A".to_string()),
            notes: None,
        }])
        .unwrap();
        assert!(calendar.contains("BEGIN:VCALENDAR\r\n"));
        assert!(calendar.contains("SUMMARY:评审\\,同步"));
        assert!(calendar.contains("LOCATION:会议室\\;A"));
    }

    #[test]
    fn accepts_only_read_only_declarative_plugins() {
        let mut responses = std::collections::HashMap::new();
        responses.insert(
            "lookup".to_string(),
            serde_json::json!({ "answer": "Piko" }),
        );
        let package = DeclarativePluginPackage {
            manifest: PluginManifest {
                id: "piko.external.team-info".to_string(),
                name: "团队说明".to_string(),
                version: "1.0.0".to_string(),
                description: "固定团队说明".to_string(),
                tools: vec![PluginToolManifest {
                    name: "lookup".to_string(),
                    description: "读取团队说明".to_string(),
                    input_schema: serde_json::json!({ "type": "object", "properties": {} }),
                    risk: "read".to_string(),
                    confirmation: "never".to_string(),
                }],
            },
            runtime: None,
            module: None,
            responses,
        };
        assert!(validate_declarative_plugin(&package).is_ok());

        let mut unsafe_package = package.clone();
        unsafe_package.manifest.tools[0].risk = "write".to_string();
        assert!(validate_declarative_plugin(&unsafe_package).is_err());
    }

    #[test]
    fn weekdays_skip_weekends() {
        let friday = chrono::Local
            .with_ymd_and_hms(2026, 9, 25, 7, 0, 0)
            .unwrap()
            .timestamp() as u64;
        let monday = chrono::Local
            .with_ymd_and_hms(2026, 9, 28, 7, 0, 0)
            .unwrap()
            .timestamp() as u64;
        assert_eq!(next_repeat_due(friday, "weekdays", friday), monday);
    }

    #[test]
    fn session_chat_history_is_limited_to_ten_entries() {
        let mut history = Vec::new();
        for index in 0..12 {
            append_session_chat_history(
                &mut history,
                ChatHistoryEntry {
                    id: index.to_string(),
                    prompt: index.to_string(),
                    response: index.to_string(),
                    created_at: index,
                },
            );
        }

        assert_eq!(history.len(), 10);
        assert_eq!(history[0].id, "11");
        assert_eq!(history[9].id, "2");
    }

    fn temp_attachment_path(extension: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "piko-attachment-{}-{}.{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            extension
        ))
    }

    fn temp_calendar_events_path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "piko-calendar-events-{}-{}.json",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }
}
