use crate::app_settings::AppSettings;
use crate::calendar_service::CalendarEvent;
use crate::chat_session::{self, ChatHistoryEntry, ChatSession};
use crate::reminder_service::Reminder;
/// Data import/export module.
///
/// Supports exporting and importing: chat history, reminders, calendar events,
/// settings, and focus records.
///
/// Security: API keys are NEVER exported (they live in keyring).
/// Temporary attachments and screenshots are NOT included.
use crate::rhythm::{persist_focus_records, read_focus_records, FocusRecord};
use crate::settings::{app_settings_path, persist_settings, read_persisted_settings};
use crate::storage;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

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
    #[serde(default = "default_ai_speech_model")]
    pub ai_speech_model: String,
    pub ai_temperature: f32,
    pub ai_timeout_seconds: u64,
}

fn default_ai_speech_model() -> String {
    "base".to_string()
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
            ai_speech_model: settings.ai.speech_model.clone(),
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
pub fn build_export_data(app: &AppHandle) -> Result<ExportData, String> {
    let settings = read_settings_for_export(app);
    let chats = crate::chat_session::repository::try_read_chat_history(app)?;
    let reminders = crate::reminder_service::read_reminders(app);
    let calendar = crate::calendar_service::read_calendar_events(app);
    let focus = read_focus_records(app);

    Ok(ExportData {
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
    })
}

/// Export data to a JSON file.
pub fn export_to_file(app: &AppHandle, path: &Path) -> Result<(), String> {
    let _transaction = storage::transaction();
    let data = build_export_data(app)?;
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    storage::write(
        path,
        &serde_json::from_str::<serde_json::Value>(&json).map_err(|e| e.to_string())?,
    )
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
/// - Only appearance/behavior preferences are merged; local model configuration is preserved
pub fn import_from_file(app: &AppHandle, path: &Path) -> Result<ImportResult, String> {
    let _transaction = storage::transaction();
    let json = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let data: ExportData = serde_json::from_str(&json).map_err(|e| e.to_string())?;

    if data.schema_version != 1 {
        return Err(format!("不支持的导出格式版本 {}", data.schema_version));
    }

    let mut imported = ImportResult::default();

    // Merge chats
    if !data.chats.is_empty() {
        (imported.chats_imported, imported.chats_skipped) = merge_chat_history(app, &data.chats)?;
    }

    // Merge reminders
    if !data.reminders.is_empty() {
        imported.reminders_imported = merge_reminders(app, &data.reminders)?;
    }

    // Merge calendar
    if !data.calendar.is_empty() {
        imported.calendar_imported = merge_calendar(app, &data.calendar)?;
    }

    // Merge focus
    if !data.focus.is_empty() {
        imported.focus_imported = merge_focus(app, &data.focus)?;
    }

    // Merge settings
    if let Some(settings) = &data.settings {
        merge_settings(app, settings)?;
        imported.settings_imported = true;
    }

    Ok(imported)
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub chats_imported: usize,
    /// Incoming records omitted because of duplicate IDs or session retention.
    pub chats_skipped: usize,
    pub reminders_imported: usize,
    pub calendar_imported: usize,
    pub focus_imported: usize,
    pub settings_imported: bool,
}

// --- Read functions (reuse existing lib.rs patterns) ---

fn read_settings_for_export(app: &AppHandle) -> Option<SanitizedSettings> {
    app_settings_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str::<AppSettings>(&json).ok())
        .map(|s| SanitizedSettings::from(&s))
}

// --- Path helpers ---

// --- Merge functions ---

fn merge_chat_entries(
    existing: &[ChatHistoryEntry],
    incoming: &[ChatHistoryEntry],
) -> (Vec<ChatSession>, usize, usize) {
    let mut ids = existing
        .iter()
        .map(|entry| entry.id.clone())
        .collect::<std::collections::HashSet<_>>();
    let mut merged = existing.to_vec();
    let mut added = std::collections::HashSet::new();
    for entry in incoming {
        if ids.insert(entry.id.clone()) {
            added.insert(entry.id.clone());
            merged.push(entry.clone());
        }
    }
    let mut sessions = chat_session::sessions_from_entries(&merged);
    chat_session::trim_sessions(&mut sessions);
    let retained = sessions
        .iter()
        .flat_map(|session| &session.messages)
        .filter_map(|message| message.source_entry_id.as_ref())
        .filter(|id| added.contains(*id))
        .collect::<std::collections::HashSet<_>>()
        .len();
    (sessions, retained, incoming.len() - retained)
}

fn merge_chat_history(
    app: &AppHandle,
    incoming: &[ChatHistoryEntry],
) -> Result<(usize, usize), String> {
    let _transaction = storage::transaction();
    let existing_sessions = crate::chat_session::repository::load_chat_sessions(app, false)?;
    let existing = chat_session::entries_view(&existing_sessions);
    let (sessions, imported, skipped) = merge_chat_entries(&existing, incoming);
    if imported > 0 {
        crate::chat_session::repository::persist_chat_sessions(app, &sessions)?;
    }
    Ok((imported, skipped))
}

fn merge_reminders(app: &AppHandle, incoming: &[Reminder]) -> Result<usize, String> {
    let _transaction = storage::transaction();
    let existing_ids = crate::reminder_service::read_reminders(app)
        .iter()
        .map(|r| r.id.clone())
        .collect::<std::collections::HashSet<_>>();

    let mut existing = crate::reminder_service::read_reminders(app);
    let mut count = 0;

    for reminder in incoming {
        if !existing_ids.contains(&reminder.id) {
            existing.push(reminder.clone());
            count += 1;
        }
    }

    if count > 0 {
        crate::reminder_service::persist_reminders(app, &existing)?;
    }
    Ok(count)
}

fn merge_calendar(app: &AppHandle, incoming: &[CalendarEvent]) -> Result<usize, String> {
    let _transaction = storage::transaction();
    let existing_ids = crate::calendar_service::read_calendar_events(app)
        .iter()
        .map(|e| e.id.clone())
        .collect::<std::collections::HashSet<_>>();

    let mut existing = crate::calendar_service::read_calendar_events(app);
    let mut count = 0;

    for event in incoming {
        if !existing_ids.contains(&event.id) {
            existing.push(event.clone());
            count += 1;
        }
    }

    if count > 0 {
        crate::calendar_service::persist_calendar_events(app, &existing)?;
    }
    Ok(count)
}

fn merge_focus(app: &AppHandle, incoming: &[FocusRecord]) -> Result<usize, String> {
    let _transaction = storage::transaction();
    let existing_ids = read_focus_records(app)
        .iter()
        .map(|r| r.completed_at)
        .collect::<std::collections::HashSet<_>>();

    let mut existing = read_focus_records(app);
    let mut count = 0;

    for record in incoming {
        if !existing_ids.contains(&record.completed_at) {
            existing.push(record.clone());
            count += 1;
        }
    }

    if count > 0 {
        persist_focus_records(app, &existing)?;
    }
    Ok(count)
}

fn merge_settings(app: &AppHandle, incoming: &SanitizedSettings) -> Result<(), String> {
    let _transaction = storage::transaction();
    let mut settings = read_persisted_settings(app)?;
    merge_preferences(&mut settings, incoming);
    persist_settings(app, &settings)
}

fn merge_preferences(settings: &mut AppSettings, incoming: &SanitizedSettings) {
    // Connection settings are local trust decisions. An imported backup must not
    // redirect requests carrying the existing key to another provider or host.
    settings.quiet_mode = incoming.quiet_mode.clone();
    settings.companion_name = incoming.companion_name.clone();
    settings.theme = incoming.theme.clone();
    settings.sensing_paused = incoming.sensing_paused;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(index: u64, created_at: u64) -> ChatHistoryEntry {
        ChatHistoryEntry {
            conversation_id: None,
            id: format!("entry-{index}"),
            prompt: format!("question {index}"),
            response: format!("answer {index}"),
            created_at,
        }
    }

    #[test]
    fn imported_preferences_cannot_replace_local_model_configuration() {
        let mut local = AppSettings::default();
        let original_ai = serde_json::to_value(&local.ai).unwrap();
        let mut imported = SanitizedSettings::from(&local);
        imported.companion_name = "Restored pet".into();
        imported.ai_provider = "anthropic".into();
        imported.ai_base_url = "https://untrusted.example/v1".into();
        imported.ai_model = "untrusted-model".into();
        imported.ai_speech_model = "untrusted-speech".into();
        imported.ai_temperature = 100.0;
        imported.ai_timeout_seconds = 0;
        merge_preferences(&mut local, &imported);
        assert_eq!(local.companion_name, "Restored pet");
        assert_eq!(serde_json::to_value(&local.ai).unwrap(), original_ai);
    }

    #[test]
    fn imports_more_than_fifty_turns_into_empty_or_populated_history() {
        let all: Vec<_> = (0..120).map(|i| entry(i, i)).collect();
        for split in [0, 60] {
            let (sessions, imported, skipped) = merge_chat_entries(&all[..split], &all[split..]);
            assert_eq!(imported, 120 - split);
            assert_eq!(skipped, 0);
            assert_eq!(chat_session::entries_view(&sessions).len(), 120);
        }
    }

    #[test]
    fn imports_deduplicate_and_keep_existing_content() {
        let original = entry(1, 1);
        let mut duplicate = original.clone();
        duplicate.response = "must not replace local content".into();
        let added = entry(2, 2);
        let (sessions, imported, skipped) =
            merge_chat_entries(&[original], &[duplicate, added.clone(), added]);
        assert_eq!((imported, skipped), (1, 2));
        let entries = chat_session::entries_view(&sessions);
        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries.iter().find(|e| e.id == "entry-1").unwrap().response,
            "answer 1"
        );
    }

    #[test]
    fn session_retention_counts_only_records_actually_retained() {
        let incoming: Vec<_> = (0..205)
            .map(|i| entry(i, i * (chat_session::SESSION_GAP_SECONDS + 1)))
            .collect();
        let (sessions, imported, skipped) = merge_chat_entries(&[], &incoming);
        assert_eq!(sessions.len(), chat_session::MAX_SESSIONS);
        assert_eq!((imported, skipped), (200, 5));
        assert!(chat_session::entries_view(&sessions)
            .iter()
            .all(|e| e.created_at >= 5 * (chat_session::SESSION_GAP_SECONDS + 1)));
    }
}
