//! Configuration repository. Types/defaults live in app_settings; credentials stay separate.
use crate::{app_settings::AppSettings, credentials::read_api_key, storage};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[path = "settings_commands.rs"]
pub(crate) mod commands;

pub(crate) fn app_settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("app-settings.json"))
}

pub(crate) fn read_settings(app: &AppHandle) -> AppSettings {
    let mut settings: AppSettings = app_settings_path(app)
        .map(|path| storage::read_or_default(&path))
        .unwrap_or_default();
    match read_api_key() {
        Ok(key) => {
            settings.has_api_key = key.is_some();
            settings.credential_error = None;
        }
        Err(error) => {
            settings.has_api_key = false;
            settings.credential_error = Some(error);
        }
    }
    settings
}

pub(crate) fn persist_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = app_settings_path(app).ok_or("无法获取设置路径")?;
    storage::write(&path, settings)
}

/// Import/update paths must propagate invalid persisted data rather than replacing it with defaults.
pub(crate) fn read_persisted_settings(app: &AppHandle) -> Result<AppSettings, String> {
    let path = app_settings_path(app).ok_or("无法获取设置路径")?;
    storage::read(&path)
}
