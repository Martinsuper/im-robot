//! Desktop configuration commands; coordinates persistence and window notifications.
use super::{persist_settings, read_settings};
use crate::app_settings::{default_speech_model, AiSettings, AiSettingsInput, AppSettings};
use crate::credentials::{read_api_key, update_api_key};
use crate::rhythm::emit_work_rhythm_updated;
use crate::providers::{normalize_base_url, validate_ai_settings};
use crate::{app_awareness, storage};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreferencesInput {
    companion_name: String,
    theme: String,
    sensing_paused: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OnboardingStatus {
    required: bool,
    completed: bool,
    version: String,
}

#[tauri::command]
pub(crate) fn get_settings(app: AppHandle) -> AppSettings {
    read_settings(&app)
}

#[tauri::command]
pub(crate) fn update_quiet_mode(app: AppHandle, quiet_mode: String) -> Result<AppSettings, String> {
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
pub(crate) fn update_language(app: AppHandle, language: String) -> Result<AppSettings, String> {
    let _transaction = storage::transaction();
    if !["zh-CN", "en-US", "ja-JP"].contains(&language.as_str()) {
        return Err("unsupported_language".to_string());
    }
    let mut settings = read_settings(&app);
    settings.language = language;
    persist_settings(&app, &settings)?;
    let _ = app.emit("settings-updated", &settings);
    Ok(settings)
}

#[tauri::command]
pub(crate) fn update_preferences(
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
pub(crate) fn update_ai_settings(
    app: AppHandle,
    input: AiSettingsInput,
) -> Result<AppSettings, String> {
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
        context_window: input.context_window.unwrap_or_default(),
        max_output_tokens: input.max_output_tokens.unwrap_or_default(),
    };
    validate_ai_settings(&ai)?;
    update_api_key(input.api_key)?;

    let mut settings = read_settings(&app);
    settings.ai = ai;
    settings.has_api_key = read_api_key().is_some();
    persist_settings(&app, &settings)?;
    let _ = app.emit_to("panel", "settings-updated", &settings);
    let _ = app.emit_to("pet", "settings-updated", &settings);
    let _ = app.emit_to("bubble", "settings-updated", &settings);
    Ok(settings)
}

#[tauri::command]
pub(crate) fn update_agent_auto_approve_commands(
    app: AppHandle,
    enabled: bool,
) -> Result<AppSettings, String> {
    let _transaction = storage::transaction();
    let mut settings = read_settings(&app);
    settings.agent_auto_approve_commands = enabled;
    persist_settings(&app, &settings)?;
    for window in ["panel", "pet", "bubble"] {
        let _ = app.emit_to(window, "settings-updated", &settings);
    }
    Ok(settings)
}

#[tauri::command]
pub(crate) fn update_html_preview_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<AppSettings, String> {
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
pub(crate) fn get_onboarding_status(app: AppHandle) -> OnboardingStatus {
    let settings = read_settings(&app);
    OnboardingStatus {
        required: !settings.onboarding_completed,
        completed: settings.onboarding_completed,
        version: settings.onboarding_version.clone(),
    }
}

#[tauri::command]
pub(crate) fn complete_onboarding(
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
pub(crate) fn skip_onboarding(app: AppHandle) -> Result<AppSettings, String> {
    let _transaction = storage::transaction();
    let mut settings = read_settings(&app);
    settings.onboarding_completed = true;
    settings.onboarding_version = "skipped".to_string();
    persist_settings(&app, &settings)?;
    let _ = app.emit("settings-updated", &settings);
    Ok(settings)
}

#[tauri::command]
pub(crate) fn reset_onboarding(app: AppHandle) -> Result<AppSettings, String> {
    let _transaction = storage::transaction();
    let mut settings = read_settings(&app);
    settings.onboarding_completed = false;
    settings.onboarding_version = String::new();
    persist_settings(&app, &settings)?;
    let _ = app.emit("settings-updated", &settings);
    Ok(settings)
}
