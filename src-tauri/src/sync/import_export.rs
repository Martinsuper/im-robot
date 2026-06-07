/// Data import/export module.
///
/// Supports exporting and importing: chat history, reminders, calendar events,
/// settings, and focus records.
///
/// Security: API keys are NEVER exported (they live in keyring).
/// Temporary attachments and screenshots are NOT included.
use crate::{AppSettings, CalendarEvent, ChatHistoryEntry, FocusRecord, Reminder};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// Schema for data export/import.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportData {
    schema_version: u32,
    exported_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    settings: Option<SanitizedSettings>,
    #[serde(default)]
    chats: Vec<ChatHistoryEntry>,
    #[serde(default)]
    reminders: Vec<Reminder>,
    #[serde(default)]
    calendar: Vec<CalendarEvent>,
    #[serde(default)]
    focus: Vec<FocusRecord>,
}

impl Default for ExportData {
    fn default() -> Self {
        Self {
            schema_version: 1,
            exported_at: 0,
            settings: None,
            chats: Vec::new(),
            reminders: Vec::new(),
            calendar: Vec::new(),
            focus: Vec::new(),
        }
    }
}

/// Sanitized settings (no API key, no sensitive data).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SanitizedSettings {
    pub quiet_mode: String,
    pub companion_name: String,
    pub theme: String,
    pub sensing_paused: bool,
    pub ai_provider: String,
    pub ai_base_url: String,
    pub ai_model: String,
    pub ai_temperature: f32,
    pub ai_timeout_seconds: u64,
}

impl From<&AppSettings> for SanitizedSettings {
    fn from(settings: &AppSettings) -> Self {
        Self {
            quiet_mode: settings.quiet_mode.clone(),
            companion_name: settings.companion_name.clone(),
            theme: settings.theme.clone(),
            sensing_paused: settings.sensing_paused,
            ai_provider: settings.ai.provider.clone(),
            ai_base_url: settings.ai.base_url.clone(),
            ai_model: settings.ai.model.clone(),
            ai_temperature: settings.ai.temperature,
            ai_timeout_seconds: settings.ai.timeout_seconds,
        }
    }
}

/// Import preview statistics.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub schema_version: u32,
    pub chat_count: usize,
    pub reminder_count: usize,
    pub calendar_count: usize,
    pub focus_count: usize,
    pub has_settings: bool,
}

/// Build export data from current state.
pub fn build_export_data(app: &AppHandle) -> ExportData {
    let settings = read_settings_for_export(app);
    let chats = read_chat_history_for_export(app);
    let reminders = read_reminders_for_export(app);
    let calendar = read_calendar_for_export(app);
    let focus = read_focus_for_export(app);

    ExportData {
        schema_version: 1,
        exported_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        settings,
        chats,
        reminders,
        calendar,
        focus,
    }
}

/// Export data to a JSON file.
pub fn export_to_file(app: &AppHandle, path: &Path) -> Result<(), String> {
    let data = build_export_data(app);
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

/// Preview import data without modifying anything.
pub fn preview_import(path: &Path) -> Result<ImportPreview, String> {
    let json = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let data: ExportData = serde_json::from_str(&json).map_err(|e| e.to_string())?;

    if data.schema_version != 1 {
        return Err(format!(
            "不支持的导出格式版本 {}，当前支持版本 1",
            data.schema_version
        ));
    }

    Ok(ImportPreview {
        schema_version: data.schema_version,
        chat_count: data.chats.len(),
        reminder_count: data.reminders.len(),
        calendar_count: data.calendar.len(),
        focus_count: data.focus.len(),
        has_settings: data.settings.is_some(),
    })
}

/// Import data from a JSON file, merging with existing data.
///
/// Strategy:
/// - Items with existing IDs are kept (no overwrite)
/// - New items are appended
/// - Settings are merged (only non-sensitive fields)
pub fn import_from_file(app: &AppHandle, path: &Path) -> Result<ImportResult, String> {
    let json = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let data: ExportData = serde_json::from_str(&json).map_err(|e| e.to_string())?;

    if data.schema_version != 1 {
        return Err(format!("不支持的导出格式版本 {}", data.schema_version));
    }

    let mut imported = ImportResult::default();

    // Merge chats
    if !data.chats.is_empty() {
        imported.chats_imported = merge_chat_history(app, &data.chats);
    }

    // Merge reminders
    if !data.reminders.is_empty() {
        imported.reminders_imported = merge_reminders(app, &data.reminders);
    }

    // Merge calendar
    if !data.calendar.is_empty() {
        imported.calendar_imported = merge_calendar(app, &data.calendar);
    }

    // Merge focus
    if !data.focus.is_empty() {
        imported.focus_imported = merge_focus(app, &data.focus);
    }

    // Merge settings
    if let Some(settings) = &data.settings {
        merge_settings(app, settings);
        imported.settings_imported = true;
    }

    Ok(imported)
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub chats_imported: usize,
    pub reminders_imported: usize,
    pub calendar_imported: usize,
    pub focus_imported: usize,
    pub settings_imported: bool,
}

// --- Read functions (reuse existing lib.rs patterns) ---

fn read_chat_history_for_export(app: &AppHandle) -> Vec<ChatHistoryEntry> {
    chat_history_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn read_reminders_for_export(app: &AppHandle) -> Vec<Reminder> {
    reminders_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn read_calendar_for_export(app: &AppHandle) -> Vec<CalendarEvent> {
    calendar_events_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn read_focus_for_export(app: &AppHandle) -> Vec<FocusRecord> {
    focus_records_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn read_settings_for_export(app: &AppHandle) -> Option<SanitizedSettings> {
    app_settings_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str::<AppSettings>(&json).ok())
        .map(|s| SanitizedSettings::from(&s))
}

// --- Path helpers ---

fn chat_history_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("chat-history.json"))
}

fn reminders_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("reminders.json"))
}

fn calendar_events_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("calendar-events.json"))
}

fn focus_records_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("focus-records.json"))
}

fn app_settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("app-settings.json"))
}

// --- Merge functions ---

fn merge_chat_history(app: &AppHandle, incoming: &[ChatHistoryEntry]) -> usize {
    const MAX_CHAT_HISTORY: usize = 50;
    let existing_ids = read_chat_history_for_export(app)
        .iter()
        .map(|e| e.id.clone())
        .collect::<std::collections::HashSet<_>>();

    let mut existing = read_chat_history_for_export(app);
    let mut count = 0;

    for entry in incoming.iter().rev() {
        if !existing_ids.contains(&entry.id) && existing.len() < MAX_CHAT_HISTORY {
            existing.insert(0, entry.clone());
            count += 1;
        }
    }

    if count > 0 {
        let _ = persist_chat_history(app, &existing);
    }
    count
}

fn merge_reminders(app: &AppHandle, incoming: &[Reminder]) -> usize {
    let existing_ids = read_reminders_for_export(app)
        .iter()
        .map(|r| r.id.clone())
        .collect::<std::collections::HashSet<_>>();

    let mut existing = read_reminders_for_export(app);
    let mut count = 0;

    for reminder in incoming {
        if !existing_ids.contains(&reminder.id) {
            existing.push(reminder.clone());
            count += 1;
        }
    }

    if count > 0 {
        let _ = persist_reminders(app, &existing);
    }
    count
}

fn merge_calendar(app: &AppHandle, incoming: &[CalendarEvent]) -> usize {
    let existing_ids = read_calendar_for_export(app)
        .iter()
        .map(|e| e.id.clone())
        .collect::<std::collections::HashSet<_>>();

    let mut existing = read_calendar_for_export(app);
    let mut count = 0;

    for event in incoming {
        if !existing_ids.contains(&event.id) {
            existing.push(event.clone());
            count += 1;
        }
    }

    if count > 0 {
        let _ = persist_calendar_events(app, &existing);
    }
    count
}

fn merge_focus(app: &AppHandle, incoming: &[FocusRecord]) -> usize {
    let existing_ids = read_focus_for_export(app)
        .iter()
        .map(|r| r.completed_at)
        .collect::<std::collections::HashSet<_>>();

    let mut existing = read_focus_for_export(app);
    let mut count = 0;

    for record in incoming {
        if !existing_ids.contains(&record.completed_at) {
            existing.push(record.clone());
            count += 1;
        }
    }

    if count > 0 {
        let _ = persist_focus_records(app, &existing);
    }
    count
}

fn merge_settings(app: &AppHandle, incoming: &SanitizedSettings) {
    if let Some(path) = app_settings_path(app) {
        if let Ok(json) = fs::read_to_string(&path) {
            if let Ok(mut settings) = serde_json::from_str::<AppSettings>(&json) {
                // Merge non-sensitive fields
                settings.quiet_mode = incoming.quiet_mode.clone();
                settings.companion_name = incoming.companion_name.clone();
                settings.theme = incoming.theme.clone();
                settings.sensing_paused = incoming.sensing_paused;
                settings.ai.provider = incoming.ai_provider.clone();
                settings.ai.base_url = incoming.ai_base_url.clone();
                settings.ai.model = incoming.ai_model.clone();
                settings.ai.temperature = incoming.ai_temperature;
                settings.ai.timeout_seconds = incoming.ai_timeout_seconds;

                let _ = fs::write(path, serde_json::to_string(&settings).unwrap_or_default());
            }
        }
    }
}

// --- Persist helpers (local copies to avoid dependency on lib.rs) ---

fn persist_chat_history(app: &AppHandle, history: &[ChatHistoryEntry]) -> Result<(), String> {
    let path = chat_history_path(app).ok_or_else(|| "无法获取历史记录路径".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "无法获取历史记录目录".to_string())?;
    let json = serde_json::to_string(history).map_err(|e| e.to_string())?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn persist_reminders(app: &AppHandle, reminders: &[Reminder]) -> Result<(), String> {
    let path = reminders_path(app).ok_or_else(|| "无法获取提醒记录路径".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "无法获取提醒记录目录".to_string())?;
    let json = serde_json::to_string(reminders).map_err(|e| e.to_string())?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn persist_calendar_events(app: &AppHandle, events: &[CalendarEvent]) -> Result<(), String> {
    let path = calendar_events_path(app).ok_or_else(|| "无法获取日程记录路径".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "无法获取日程记录目录".to_string())?;
    let json = serde_json::to_string(events).map_err(|e| e.to_string())?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn persist_focus_records(app: &AppHandle, records: &[FocusRecord]) -> Result<(), String> {
    let path = focus_records_path(app).ok_or_else(|| "无法获取专注记录路径".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "无法获取专注记录目录".to_string())?;
    let json = serde_json::to_string(records).map_err(|e| e.to_string())?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}
