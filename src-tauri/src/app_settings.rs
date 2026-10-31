//! Application configuration contract and defaults, independent of the desktop runtime.
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppSettings {
    pub(crate) quiet_mode: String,
    #[serde(default = "default_companion_name")]
    pub(crate) companion_name: String,
    #[serde(default = "default_theme")]
    pub(crate) theme: String,
    #[serde(default = "default_language")]
    pub(crate) language: String,
    #[serde(default)]
    pub(crate) sensing_paused: bool,
    #[serde(default = "default_break_reminders_enabled")]
    pub(crate) break_reminders_enabled: bool,
    #[serde(default = "default_break_reminder_interval_minutes")]
    pub(crate) break_reminder_interval_minutes: u64,
    #[serde(default = "default_break_reminder_cooldown_minutes")]
    pub(crate) break_reminder_cooldown_minutes: u64,
    #[serde(default = "default_break_reminder_quiet_hours_enabled")]
    pub(crate) break_reminder_quiet_hours_enabled: bool,
    #[serde(default = "default_break_reminder_quiet_hours_start")]
    pub(crate) break_reminder_quiet_hours_start: String,
    #[serde(default = "default_break_reminder_quiet_hours_end")]
    pub(crate) break_reminder_quiet_hours_end: String,
    #[serde(default)]
    pub(crate) ai: AiSettings,
    #[serde(default)]
    pub(crate) has_api_key: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) credential_error: Option<String>,
    #[serde(default)]
    pub(crate) html_preview_enabled: bool,
    #[serde(default)]
    pub(crate) agent_auto_approve_commands: bool,
    /// 单个工具调用的活性上限（04 §4.4，默认 20 分钟）；idle 超时只在不等工具/审批/契约时计数。
    #[serde(default = "default_agent_tool_timeout_minutes")]
    pub(crate) agent_tool_timeout_minutes: u64,
    /// P2 §9：coding 任务 sidecar 崩溃后自动续跑（同一任务链最多一次），默认开启。
    #[serde(default = "default_agent_auto_resume_enabled")]
    pub(crate) agent_auto_resume_enabled: bool,
    /// 全局快捷键（02 §3.3 / 06）：打开对话窗口。格式如 "CmdOrCtrl+Shift+Space"。
    #[serde(default = "default_global_shortcut")]
    pub(crate) global_shortcut: String,
    #[serde(default)]
    pub(crate) onboarding_completed: bool,
    #[serde(default)]
    pub(crate) onboarding_version: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiSettings {
    pub(crate) provider: String,
    pub(crate) base_url: String,
    pub(crate) model: String,
    #[serde(default = "default_speech_model")]
    pub(crate) speech_model: String,
    pub(crate) temperature: f32,
    pub(crate) timeout_seconds: u64,
    #[serde(default)]
    pub(crate) context_window: u64,
    #[serde(default)]
    pub(crate) max_output_tokens: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiSettingsInput {
    pub(crate) provider: String,
    pub(crate) base_url: String,
    pub(crate) model: String,
    pub(crate) speech_model: Option<String>,
    pub(crate) temperature: f32,
    pub(crate) timeout_seconds: u64,
    pub(crate) context_window: Option<u64>,
    pub(crate) max_output_tokens: Option<u64>,
    /// None = 保持原值；Some(None) = 清除；Some(Some(key)) = 写入新密钥。
    #[serde(default)]
    pub(crate) api_key: Option<Option<String>>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            quiet_mode: "balanced".to_string(),
            companion_name: default_companion_name(),
            theme: default_theme(),
            language: default_language(),
            sensing_paused: false,
            break_reminders_enabled: default_break_reminders_enabled(),
            break_reminder_interval_minutes: default_break_reminder_interval_minutes(),
            break_reminder_cooldown_minutes: default_break_reminder_cooldown_minutes(),
            break_reminder_quiet_hours_enabled: default_break_reminder_quiet_hours_enabled(),
            break_reminder_quiet_hours_start: default_break_reminder_quiet_hours_start(),
            break_reminder_quiet_hours_end: default_break_reminder_quiet_hours_end(),
            ai: AiSettings::default(),
            has_api_key: false,
            credential_error: None,
            html_preview_enabled: false,
            agent_auto_approve_commands: false,
            agent_tool_timeout_minutes: default_agent_tool_timeout_minutes(),
            agent_auto_resume_enabled: default_agent_auto_resume_enabled(),
            global_shortcut: default_global_shortcut(),
            onboarding_completed: false,
            onboarding_version: String::new(),
        }
    }
}

fn default_companion_name() -> String {
    "Piko".to_string()
}

fn default_language() -> String {
    "zh-CN".to_string()
}

fn default_theme() -> String {
    "sage".to_string()
}

fn default_global_shortcut() -> String {
    "CmdOrCtrl+Shift+Space".to_string()
}

fn default_agent_tool_timeout_minutes() -> u64 {
    20
}

fn default_agent_auto_resume_enabled() -> bool {
    true
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
            provider: "ollama".to_string(),
            base_url: "http://localhost:11434/v1".to_string(),
            model: "".to_string(),
            speech_model: default_speech_model(),
            temperature: 0.7,
            timeout_seconds: 120,
            context_window: 0,
            max_output_tokens: 0,
        }
    }
}

pub(crate) fn default_speech_model() -> String {
    "sense-voice".to_string()
}
