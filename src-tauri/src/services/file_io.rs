use crate::types::{
    AppSettings, BubbleSize, ChatHistoryEntry, PetPosition,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize};

// --- Path helpers ---

pub fn pet_position_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("pet-position.json"))
}

pub fn bubble_size_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("bubble-size.json"))
}

pub fn app_settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("app-settings.json"))
}

pub fn chat_history_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("chat-history.json"))
}

// --- Read / Persist ---

pub fn read_chat_history(app: &AppHandle) -> Vec<ChatHistoryEntry> {
    chat_history_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

pub fn persist_chat_history(app: &AppHandle, history: &[ChatHistoryEntry]) -> Result<(), String> {
    let path = chat_history_path(app).ok_or_else(|| "无法获取历史记录路径".to_string())?;
    let directory = path
        .parent()
        .ok_or_else(|| "无法获取历史记录目录".to_string())?;
    let json = serde_json::to_string(history).map_err(|error| error.to_string())?;

    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    fs::write(path, json).map_err(|error| error.to_string())
}

pub fn append_chat_history(app: &AppHandle, entry: ChatHistoryEntry) -> Result<(), String> {
    const MAX_CHAT_HISTORY: usize = 50;

    let mut history = read_chat_history(app);
    history.insert(0, entry);
    history.truncate(MAX_CHAT_HISTORY);
    persist_chat_history(app, &history)
}

pub fn read_settings(app: &AppHandle) -> AppSettings {
    let mut settings: AppSettings = app_settings_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
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
    let _ = fs::write(path, json);
}

pub fn persist_pet_position(app: &AppHandle, position: PhysicalPosition<i32>) {
    let Some(path) = pet_position_path(app) else {
        return;
    };
    let Some(directory) = path.parent() else {
        return;
    };
    let position = PetPosition {
        x: position.x,
        y: position.y,
    };
    let Ok(json) = serde_json::to_string(&position) else {
        return;
    };
    let _ = fs::create_dir_all(directory);
    let _ = fs::write(path, json);
}

pub fn persist_bubble_size(app: &AppHandle, size: PhysicalSize<u32>) {
    let Some(path) = bubble_size_path(app) else {
        return;
    };
    let Some(directory) = path.parent() else {
        return;
    };
    let size = BubbleSize {
        width: size.width,
        height: size.height,
    };
    let Ok(json) = serde_json::to_string(&size) else {
        return;
    };
    let _ = fs::create_dir_all(directory);
    let _ = fs::write(path, json);
}

pub fn restore_pet_position(app: &AppHandle) {
    let Some(path) = pet_position_path(app) else {
        return;
    };
    let Ok(json) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(position) = serde_json::from_str::<PetPosition>(&json) else {
        return;
    };
    if let Some(window) = app.get_webview_window("pet") {
        let _ = window.set_position(PhysicalPosition::new(position.x, position.y));
    }
}

pub fn restore_bubble_size(app: &AppHandle) {
    let Some(path) = bubble_size_path(app) else {
        return;
    };
    let Ok(json) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(size) = serde_json::from_str::<BubbleSize>(&json) else {
        return;
    };
    if let Some(window) = app.get_webview_window("bubble") {
        let _ = window.set_size(PhysicalSize::new(size.width, size.height));
    }
}

pub fn save_current_pet_position(app: &AppHandle) {
    let Some(window) = app.get_webview_window("pet") else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    persist_pet_position(app, position);
}

pub fn save_current_bubble_size(app: &AppHandle) {
    let Some(window) = app.get_webview_window("bubble") else {
        return;
    };
    let Ok(inner_size) = window.inner_size() else {
        return;
    };
    persist_bubble_size(app, inner_size);
}

use super::keychain::read_api_key;
