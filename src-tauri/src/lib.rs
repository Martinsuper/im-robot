use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use screenshots::{image::DynamicImage, Screen};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalPosition, Manager, PhysicalPosition, PhysicalSize, State,
    WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

const PET_MARGIN: i32 = 16;
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
    #[serde(default)]
    ai: AiSettings,
    #[serde(default)]
    has_api_key: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiSettings {
    provider: String,
    base_url: String,
    model: String,
    temperature: f32,
    timeout_seconds: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiSettingsInput {
    provider: String,
    base_url: String,
    model: String,
    temperature: f32,
    timeout_seconds: u64,
    api_key: Option<String>,
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
struct PreferencesInput {
    companion_name: String,
    theme: String,
    sensing_paused: bool,
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
    rename_all = "camelCase",
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
    Cancelled {
        request_id: String,
    },
    Failed {
        request_id: String,
        message: String,
    },
}

#[derive(Default)]
struct ChatRequests(Mutex<HashMap<String, Arc<AtomicBool>>>);

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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReminderInput {
    title: String,
    due_at: u64,
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
    AmbientNudge,
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

fn default_companion_name() -> String {
    "Piko".to_string()
}

fn default_theme() -> String {
    "sage".to_string()
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

fn read_chat_history(app: &AppHandle) -> Vec<ChatHistoryEntry> {
    chat_history_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn persist_chat_history(app: &AppHandle, history: &[ChatHistoryEntry]) -> Result<(), String> {
    let path = chat_history_path(app).ok_or_else(|| "无法获取历史记录路径".to_string())?;
    let directory = path
        .parent()
        .ok_or_else(|| "无法获取历史记录目录".to_string())?;
    let json = serde_json::to_string(history).map_err(|error| error.to_string())?;

    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    fs::write(path, json).map_err(|error| error.to_string())
}

fn append_chat_history(app: &AppHandle, entry: ChatHistoryEntry) -> Result<(), String> {
    const MAX_CHAT_HISTORY: usize = 50;

    let mut history = read_chat_history(app);
    history.insert(0, entry);
    history.truncate(MAX_CHAT_HISTORY);
    persist_chat_history(app, &history)
}

fn read_reminders(app: &AppHandle) -> Vec<Reminder> {
    reminders_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn persist_reminders(app: &AppHandle, reminders: &[Reminder]) -> Result<(), String> {
    let path = reminders_path(app).ok_or_else(|| "无法获取提醒记录路径".to_string())?;
    let directory = path
        .parent()
        .ok_or_else(|| "无法获取提醒记录目录".to_string())?;
    let json = serde_json::to_string(reminders).map_err(|error| error.to_string())?;

    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    fs::write(path, json).map_err(|error| error.to_string())
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

fn read_settings(app: &AppHandle) -> AppSettings {
    let mut settings: AppSettings = app_settings_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    settings.has_api_key = read_api_key().is_some();
    settings
}

fn persist_settings(app: &AppHandle, settings: &AppSettings) {
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

fn validate_ai_settings(settings: &AiSettings) -> Result<(), String> {
    if settings.provider != "openai-compatible" {
        return Err("当前仅支持 OpenAI-Compatible 服务".to_string());
    }
    if !(settings.base_url.starts_with("http://") || settings.base_url.starts_with("https://")) {
        return Err("Base URL 必须以 http:// 或 https:// 开头".to_string());
    }
    if settings.model.trim().is_empty() {
        return Err("模型名称不能为空".to_string());
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
    method: reqwest::Method,
    url: String,
) -> reqwest::RequestBuilder {
    let builder = client.request(method, url);
    if let Some(api_key) = read_api_key() {
        builder.bearer_auth(api_key)
    } else {
        builder
    }
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
    let is_visible = window
        .available_monitors()
        .map(|monitors| {
            monitors
                .iter()
                .any(|monitor| monitor_contains(*monitor.position(), *monitor.size(), position))
        })
        .unwrap_or(false);

    if is_visible {
        let _ = window.set_position(position);
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

#[tauri::command]
fn move_pet(app: AppHandle, x: f64, y: f64) {
    if let Some(window) = app.get_webview_window("pet") {
        let _ = window.set_position(LogicalPosition::new(x, y));
    }
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
    let revision = Arc::new(AtomicU64::new(0));
    let app = app.clone();

    window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::Moved(_)) {
            return;
        }

        let revision = Arc::clone(&revision);
        let current = revision.fetch_add(1, Ordering::Relaxed) + 1;
        let app = app.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(PET_MOVE_DEBOUNCE_MS));
            if revision.load(Ordering::Relaxed) == current {
                save_current_pet_position(&app);
            }
        });
    });
}

fn watch_bubble_resize(app: &AppHandle) {
    let Some(window) = app.get_webview_window("bubble") else {
        return;
    };
    let revision = Arc::new(AtomicU64::new(0));
    let app = app.clone();

    window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::Resized(_)) {
            return;
        }

        let revision = Arc::clone(&revision);
        let current = revision.fetch_add(1, Ordering::Relaxed) + 1;
        let app = app.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(PET_MOVE_DEBOUNCE_MS));
            if revision.load(Ordering::Relaxed) == current {
                save_current_bubble_size(&app);
            }
        });
    });
}

#[cfg(target_os = "macos")]
fn enable_pet_background_drag(app: &AppHandle) {
    let Some(window) = app.get_webview_window("pet") else {
        return;
    };

    let _ = window.with_webview(|webview| unsafe {
        let ns_window: &objc2_app_kit::NSWindow = &*webview.ns_window().cast();
        ns_window.setMovableByWindowBackground(true);
    });
}

#[cfg(not(target_os = "macos"))]
fn enable_pet_background_drag(_app: &AppHandle) {}

#[cfg(target_os = "macos")]
fn enable_bubble_background_drag(app: &AppHandle) {
    let Some(window) = app.get_webview_window("bubble") else {
        return;
    };

    let _ = window.with_webview(|webview| unsafe {
        let ns_window: &objc2_app_kit::NSWindow = &*webview.ns_window().cast();
        ns_window.setMovableByWindowBackground(true);
    });
}

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
fn open_panel(app: AppHandle) {
    show_and_focus(&app, "panel");
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

#[tauri::command]
fn begin_screen_capture(app: AppHandle) -> Result<(), String> {
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
    let x = origin.x + (selection.x * scale).round() as i32;
    let y = origin.y + (selection.y * scale).round() as i32;
    let width = (selection.width * scale).round() as u32;
    let height = (selection.height * scale).round() as u32;
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
        "截图时按需申请，首次使用请允许屏幕录制".to_string()
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
fn clear_chat_history(app: AppHandle) -> Result<(), String> {
    persist_chat_history(&app, &[])
}

#[tauri::command]
fn list_reminders(app: AppHandle) -> Vec<Reminder> {
    let mut reminders = read_reminders(&app);
    reminders.sort_by_key(|reminder| reminder.due_at);
    reminders
}

#[tauri::command]
fn create_reminder(app: AppHandle, input: ReminderInput) -> Result<Reminder, String> {
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

    let reminder = Reminder {
        id: reminder_id(),
        title: title.to_string(),
        due_at: input.due_at,
        status: "pending".to_string(),
    };
    let mut reminders = read_reminders(&app);
    reminders.push(reminder.clone());
    persist_reminders(&app, &reminders)?;
    Ok(reminder)
}

#[tauri::command]
fn delete_reminder(app: AppHandle, id: String) -> Result<(), String> {
    let mut reminders = read_reminders(&app);
    let previous_len = reminders.len();
    reminders.retain(|reminder| reminder.id != id);
    if reminders.len() == previous_len {
        return Err("未找到该提醒".to_string());
    }
    persist_reminders(&app, &reminders)
}

fn collect_due_reminders(reminders: &mut [Reminder], now: u64) -> Vec<Reminder> {
    let mut due = Vec::new();
    for reminder in reminders {
        if reminder.status == "pending" && reminder.due_at <= now {
            reminder.status = "triggered".to_string();
            due.push(reminder.clone());
        }
    }
    due
}

fn process_due_reminders(app: &AppHandle) -> Result<Vec<Reminder>, String> {
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

fn watch_reminders(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || loop {
        let _ = process_due_reminders(&app);
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
    if !["active", "balanced", "minimal"].contains(&quiet_mode.as_str()) {
        return Err("Unsupported quiet mode".to_string());
    }

    let mut settings = read_settings(&app);
    settings.quiet_mode = quiet_mode;
    persist_settings(&app, &settings);
    let _ = app.emit_to("pet", "settings-updated", &settings);
    Ok(settings)
}

#[tauri::command]
fn update_preferences(app: AppHandle, input: PreferencesInput) -> Result<AppSettings, String> {
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
    persist_settings(&app, &settings);
    let _ = app.emit_to("pet", "settings-updated", &settings);
    let _ = app.emit_to("bubble", "settings-updated", &settings);
    Ok(settings)
}

#[tauri::command]
fn update_ai_settings(app: AppHandle, input: AiSettingsInput) -> Result<AppSettings, String> {
    let ai = AiSettings {
        provider: input.provider,
        base_url: normalize_base_url(&input.base_url),
        model: input.model.trim().to_string(),
        temperature: input.temperature,
        timeout_seconds: input.timeout_seconds,
    };
    validate_ai_settings(&ai)?;
    update_api_key(input.api_key)?;

    let mut settings = read_settings(&app);
    settings.ai = ai;
    settings.has_api_key = read_api_key().is_some();
    persist_settings(&app, &settings);
    Ok(settings)
}

#[tauri::command]
async fn list_models(app: AppHandle) -> Result<Vec<ModelInfo>, String> {
    let settings = read_settings(&app);
    validate_ai_settings(&settings.ai)?;
    let client = http_client(&settings.ai)?;
    let response = request_builder(
        &client,
        reqwest::Method::GET,
        format!("{}/models", normalize_base_url(&settings.ai.base_url)),
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

    Ok(body["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|model| model["id"].as_str())
        .map(|id| ModelInfo { id: id.to_string() })
        .collect())
}

fn extract_chat_deltas(line: &str) -> Vec<String> {
    let Some(data) = line.strip_prefix("data:") else {
        return Vec::new();
    };
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return Vec::new();
    }

    serde_json::from_str::<Value>(data)
        .ok()
        .and_then(|body| {
            body["choices"][0]["delta"]["content"]
                .as_str()
                .map(str::to_string)
        })
        .into_iter()
        .collect()
}

fn emit_chat_event(app: &AppHandle, event: ChatEvent) {
    let _ = app.emit_to("bubble", "chat-event", event.clone());
    let _ = app.emit_to("pet", "chat-event", event);
}

async fn stream_chat(
    app: &AppHandle,
    request_id: &str,
    prompt: &str,
    history_prompt: &str,
    screenshot: Option<&ScreenCapture>,
    working: bool,
    cancelled: &AtomicBool,
) -> Result<bool, String> {
    let settings = read_settings(app);
    validate_ai_settings(&settings.ai)?;
    if prompt.trim().is_empty() {
        return Err("问题不能为空".to_string());
    }

    emit_chat_event(
        app,
        ChatEvent::Started {
            request_id: request_id.to_string(),
            working,
        },
    );

    let client = http_client(&settings.ai)?;
    let user_content = if let Some(screenshot) = screenshot {
        json!([
            { "type": "text", "text": prompt.trim() },
            { "type": "image_url", "image_url": { "url": screenshot.data_url } }
        ])
    } else {
        json!(prompt.trim())
    };
    let recent_history = read_chat_history(app);
    let mut messages = vec![json!({
        "role": "system",
        "content": format!(
            "你是桌面 AI 宠物精灵 {}。回答应清晰、简洁、友好。不要声称已经执行未实际执行的电脑操作。",
            settings.companion_name
        )
    })];
    for entry in recent_history.iter().take(6).rev() {
        messages.push(json!({ "role": "user", "content": entry.prompt }));
        messages.push(json!({ "role": "assistant", "content": entry.response }));
    }
    messages.push(json!({ "role": "user", "content": user_content }));
    let response = request_builder(
        &client,
        reqwest::Method::POST,
        format!(
            "{}/chat/completions",
            normalize_base_url(&settings.ai.base_url)
        ),
    )
    .json(&json!({
        "model": settings.ai.model,
        "messages": messages,
        "temperature": settings.ai.temperature,
        "stream": true
    }))
    .send()
    .await
    .map_err(|error| error.to_string())?
    .error_for_status()
    .map_err(|error| error.to_string())?;
    let mut response = response;
    let mut buffer = String::new();
    let mut assistant_response = String::new();
    let mut sequence = 0;

    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(true);
        }
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(newline) = buffer.find('\n') {
            let line = buffer.drain(..=newline).collect::<String>();
            for text in extract_chat_deltas(line.trim()) {
                assistant_response.push_str(&text);
                sequence += 1;
                emit_chat_event(
                    app,
                    ChatEvent::Delta {
                        request_id: request_id.to_string(),
                        sequence,
                        text,
                    },
                );
            }
        }
    }

    for text in extract_chat_deltas(buffer.trim()) {
        assistant_response.push_str(&text);
        sequence += 1;
        emit_chat_event(
            app,
            ChatEvent::Delta {
                request_id: request_id.to_string(),
                sequence,
                text,
            },
        );
    }

    append_chat_history(
        app,
        ChatHistoryEntry {
            id: request_id.to_string(),
            prompt: history_prompt.to_string(),
            response: assistant_response,
            created_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        },
    )?;
    let _ = app.emit_to("panel", "chat-history-updated", ());

    if cancelled.load(Ordering::Relaxed) {
        return Ok(true);
    }

    emit_chat_event(
        app,
        ChatEvent::Completed {
            request_id: request_id.to_string(),
        },
    );
    Ok(false)
}

fn build_attachment_prompt(
    prompt: &str,
    attachment_action: Option<&str>,
    attachment: Option<&TextAttachment>,
) -> Result<(String, String), String> {
    let prompt = prompt.trim();
    let Some(action) = attachment_action else {
        if prompt.is_empty() {
            return Err("问题不能为空".to_string());
        }
        return Ok((prompt.to_string(), prompt.to_string()));
    };
    let attachment = attachment.ok_or_else(|| "请先拖入一个文本文件".to_string())?;
    let instruction = match action {
        "summarize" => "请总结附件内容，先给出要点，再给出简短结论。",
        "translate" => "请将附件内容翻译成中文；如果原文已经是中文，则翻译成英文。",
        "explain" => "请解释附件内容，指出结构、关键概念和需要注意的地方。",
        _ => return Err("不支持的附件处理动作".to_string()),
    };
    let user_note = if prompt.is_empty() {
        String::new()
    } else {
        format!("\n\n用户补充要求：{prompt}")
    };
    Ok((
        format!(
            "{instruction}\n\n附件名称：{}\n\n附件正文：\n{}{}",
            attachment.display_name, attachment.content, user_note
        ),
        format!(
            "[附件{}] {}",
            attachment_action_label(action),
            attachment.display_name
        ),
    ))
}

fn attachment_action_label(action: &str) -> &str {
    match action {
        "summarize" => "总结",
        "translate" => "翻译",
        "explain" => "解释",
        _ => "处理",
    }
}

#[tauri::command]
async fn chat_start(
    app: AppHandle,
    requests: State<'_, ChatRequests>,
    attachments: State<'_, TextAttachmentStore>,
    captures: State<'_, ScreenCaptureStore>,
    input: ChatStartInput,
) -> Result<(), String> {
    let attachment = attachments
        .0
        .lock()
        .map_err(|_| "无法读取附件状态".to_string())?
        .clone();
    let prompt = if input.include_screenshot.unwrap_or(false) && input.prompt.trim().is_empty() {
        "请描述截图中的内容，并指出值得注意的信息。"
    } else {
        &input.prompt
    };
    let (model_prompt, history_prompt) = build_attachment_prompt(
        prompt,
        input.attachment_action.as_deref(),
        attachment.as_ref(),
    )?;
    let screenshot = if input.include_screenshot.unwrap_or(false) {
        captures
            .0
            .lock()
            .map_err(|_| "无法读取截图状态".to_string())?
            .clone()
            .ok_or_else(|| "请先框选截图区域".to_string())?
            .into()
    } else {
        None
    };
    let history_prompt = if screenshot.is_some() {
        format!("[截图] {history_prompt}")
    } else {
        history_prompt
    };
    let working = input.attachment_action.is_some() || screenshot.is_some();
    let cancelled = Arc::new(AtomicBool::new(false));
    requests
        .0
        .lock()
        .map_err(|_| "无法记录当前生成任务".to_string())?
        .insert(input.request_id.clone(), Arc::clone(&cancelled));

    let result = stream_chat(
        &app,
        &input.request_id,
        &model_prompt,
        &history_prompt,
        screenshot.as_ref(),
        working,
        &cancelled,
    )
    .await;
    if let Ok(mut active) = requests.0.lock() {
        active.remove(&input.request_id);
    }

    if matches!(result, Ok(true)) {
        emit_chat_event(
            &app,
            ChatEvent::Cancelled {
                request_id: input.request_id.clone(),
            },
        );
    }
    if let Err(message) = &result {
        emit_chat_event(
            &app,
            ChatEvent::Failed {
                request_id: input.request_id,
                message: message.clone(),
            },
        );
    }
    result.map(|_| ())
}

#[tauri::command]
fn chat_cancel(requests: State<'_, ChatRequests>, request_id: String) -> Result<(), String> {
    if let Some(cancelled) = requests
        .0
        .lock()
        .map_err(|_| "无法读取当前生成任务".to_string())?
        .get(&request_id)
    {
        cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
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
        .manage(TextAttachmentStore::default())
        .manage(ScreenCaptureStore::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            configure_tray(app)?;
            configure_global_shortcut(app)?;
            persist_settings(app.handle(), &read_settings(app.handle()));
            restore_pet_position(app.handle());
            watch_pet_position(app.handle());
            restore_bubble_size(app.handle());
            watch_bubble_resize(app.handle());
            enable_pet_background_drag(app.handle());
            enable_bubble_background_drag(app.handle());
            watch_reminders(app.handle());
            watch_ambient_nudges(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            show_bubble,
            hide_bubble,
            open_panel,
            show_pet,
            hide_pet,
            begin_screen_capture,
            cancel_screen_capture,
            confirm_screen_capture,
            get_screen_capture_preview,
            clear_screen_capture,
            move_pet,
            get_settings,
            screen_capture_permission_status,
            check_for_updates,
            list_chat_history,
            clear_chat_history,
            list_reminders,
            create_reminder,
            delete_reminder,
            prepare_text_attachment,
            clear_text_attachment,
            update_quiet_mode,
            update_preferences,
            update_ai_settings,
            list_models,
            chat_start,
            chat_cancel
        ])
        .run(tauri::generate_context!())
        .expect("error while running Piko desktop application");
}

#[cfg(test)]
mod tests {
    use super::{
        build_attachment_prompt, collect_due_reminders, extract_chat_deltas, monitor_contains,
        normalize_base_url, read_text_attachment, should_bypass_system_proxy, version_parts,
        AppSettings, ChatEvent, Reminder, TextAttachment,
    };
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };
    use tauri::{PhysicalPosition, PhysicalSize};

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
    fn defaults_to_balanced_quiet_mode() {
        let settings = AppSettings::default();
        assert_eq!(settings.quiet_mode, "balanced");
        assert_eq!(settings.companion_name, "Piko");
        assert_eq!(settings.theme, "sage");
        assert!(!settings.sensing_paused);
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
            extract_chat_deltas(r#"data: {"choices":[{"delta":{"content":"你好"}}]}"#),
            vec!["你好".to_string()]
        );
        assert!(extract_chat_deltas("data: [DONE]").is_empty());
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
    fn serializes_chat_event_types_as_camel_case() {
        let json = serde_json::to_value(ChatEvent::Completed {
            request_id: "request-1".to_string(),
        })
        .expect("chat event should serialize");

        assert_eq!(json["type"], "completed");
        assert_eq!(json["requestId"], "request-1");
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
            },
            Reminder {
                id: "future".to_string(),
                title: "稍后".to_string(),
                due_at: 11,
                status: "pending".to_string(),
            },
            Reminder {
                id: "done".to_string(),
                title: "完成".to_string(),
                due_at: 8,
                status: "triggered".to_string(),
            },
        ];

        let due = collect_due_reminders(&mut reminders, 10);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, "due");
        assert_eq!(reminders[0].status, "triggered");
        assert!(collect_due_reminders(&mut reminders, 10).is_empty());
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
}
