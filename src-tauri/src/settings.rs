//! 应用设置的类型定义、持久化（含进程内 mtime 缓存）与 keyring 凭据存取。

use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex, time::SystemTime};
use tauri::{AppHandle, Manager};

const KEYRING_SERVICE: &str = "com.duanluyao.imrobot";
const KEYRING_ACCOUNT: &str = "provider-api-key";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub quiet_mode: String,
    #[serde(default = "default_companion_name")]
    pub companion_name: String,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default)]
    pub sensing_paused: bool,
    #[serde(default = "default_break_reminders_enabled")]
    pub break_reminders_enabled: bool,
    #[serde(default = "default_break_reminder_interval_minutes")]
    pub break_reminder_interval_minutes: u64,
    #[serde(default = "default_break_reminder_cooldown_minutes")]
    pub break_reminder_cooldown_minutes: u64,
    #[serde(default = "default_break_reminder_quiet_hours_enabled")]
    pub break_reminder_quiet_hours_enabled: bool,
    #[serde(default = "default_break_reminder_quiet_hours_start")]
    pub break_reminder_quiet_hours_start: String,
    #[serde(default = "default_break_reminder_quiet_hours_end")]
    pub break_reminder_quiet_hours_end: String,
    #[serde(default)]
    pub ai: AiSettings,
    #[serde(default)]
    pub has_api_key: bool,
    #[serde(default)]
    pub html_preview_enabled: bool,
    #[serde(default)]
    pub onboarding_completed: bool,
    #[serde(default)]
    pub onboarding_version: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub temperature: f32,
    pub timeout_seconds: u64,
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
            temperature: 0.7,
            timeout_seconds: 120,
        }
    }
}

pub fn app_settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("app-settings.json"))
}

/// 进程内 settings 缓存：轮询线程每 1-2 秒读一次设置，mtime 未变化时直接
/// 返回缓存副本，避免持续读盘。写盘成功后同步缓存，失败则失效。
struct SettingsCacheEntry {
    path: PathBuf,
    mtime: SystemTime,
    settings: AppSettings,
}

static SETTINGS_CACHE: Mutex<Option<SettingsCacheEntry>> = Mutex::new(None);

pub fn read_settings(app: &AppHandle) -> AppSettings {
    let path = app_settings_path(app);
    let mtime = path.as_ref().and_then(|path| {
        fs::metadata(path)
            .and_then(|metadata| metadata.modified())
            .ok()
    });

    if let (Some(path), Some(mtime)) = (path.as_ref(), mtime) {
        let cache = SETTINGS_CACHE
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(entry) = cache.as_ref() {
            if entry.path == *path && entry.mtime == mtime {
                let mut settings = entry.settings.clone();
                settings.has_api_key = read_api_key().is_some();
                return settings;
            }
        }
    }

    let settings: AppSettings = path
        .as_ref()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();

    if let (Some(path), Some(mtime)) = (path.as_ref(), mtime) {
        let mut cache = SETTINGS_CACHE
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *cache = Some(SettingsCacheEntry {
            path: path.clone(),
            mtime,
            settings: settings.clone(),
        });
    }

    let mut settings = settings;
    settings.has_api_key = read_api_key().is_some();
    settings
}

pub fn persist_settings(app: &AppHandle, settings: &AppSettings) {
    let Some(path) = app_settings_path(app) else {
        return;
    };
    let Some(directory) = path.parent() else {
        return;
    };
    let Ok(json) = serde_json::to_string(settings) else {
        return;
    };

    let _ = fs::create_dir_all(directory);
    if fs::write(&path, json).is_err() {
        // 写盘失败时使缓存失效，下次读取重新从磁盘加载
        let mut cache = SETTINGS_CACHE
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *cache = None;
        return;
    }
    if let Ok(mtime) = fs::metadata(&path).and_then(|metadata| metadata.modified()) {
        let mut cache = SETTINGS_CACHE
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *cache = Some(SettingsCacheEntry {
            path,
            mtime,
            settings: settings.clone(),
        });
    }
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|error| error.to_string())
}

pub fn read_api_key() -> Option<String> {
    keyring_entry().ok()?.get_password().ok()
}

pub fn update_api_key(api_key: Option<String>) -> Result<(), String> {
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
