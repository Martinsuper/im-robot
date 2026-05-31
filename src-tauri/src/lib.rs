use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
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
    AppHandle, Emitter, LogicalPosition, Manager, PhysicalPosition, State, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const PET_MARGIN: i32 = 16;
const PET_MOVE_DEBOUNCE_MS: u64 = 220;
const KEYRING_SERVICE: &str = "com.duanluyao.imrobot";
const KEYRING_ACCOUNT: &str = "provider-api-key";

#[derive(Debug, Deserialize, Serialize)]
struct PetPosition {
    x: i32,
    y: i32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    quiet_mode: String,
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelInfo {
    id: String,
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

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            quiet_mode: "balanced".to_string(),
            ai: AiSettings::default(),
            has_api_key: false,
        }
    }
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
fn get_settings(app: AppHandle) -> AppSettings {
    read_settings(&app)
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
fn update_quiet_mode(app: AppHandle, quiet_mode: String) -> Result<AppSettings, String> {
    if !["active", "balanced", "minimal"].contains(&quiet_mode.as_str()) {
        return Err("Unsupported quiet mode".to_string());
    }

    let mut settings = read_settings(&app);
    settings.quiet_mode = quiet_mode;
    persist_settings(&app, &settings);
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
        },
    );

    let client = http_client(&settings.ai)?;
    let response = request_builder(
        &client,
        reqwest::Method::POST,
        format!("{}/chat/completions", normalize_base_url(&settings.ai.base_url)),
    )
    .json(&json!({
        "model": settings.ai.model,
        "messages": [
            {
                "role": "system",
                "content": "你是桌面 AI 宠物精灵 Piko。回答应清晰、简洁、友好。不要声称已经执行未实际执行的电脑操作。"
            },
            { "role": "user", "content": prompt.trim() }
        ],
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
            prompt: prompt.trim().to_string(),
            response: assistant_response,
            created_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        },
    )?;

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

#[tauri::command]
async fn chat_start(
    app: AppHandle,
    requests: State<'_, ChatRequests>,
    request_id: String,
    prompt: String,
) -> Result<(), String> {
    let cancelled = Arc::new(AtomicBool::new(false));
    requests
        .0
        .lock()
        .map_err(|_| "无法记录当前生成任务".to_string())?
        .insert(request_id.clone(), Arc::clone(&cancelled));

    let result = stream_chat(&app, &request_id, &prompt, &cancelled).await;
    if let Ok(mut active) = requests.0.lock() {
        active.remove(&request_id);
    }

    if matches!(result, Ok(true)) {
        emit_chat_event(
            &app,
            ChatEvent::Cancelled {
                request_id: request_id.clone(),
            },
        );
    }
    if let Err(message) = &result {
        emit_chat_event(
            &app,
            ChatEvent::Failed {
                request_id,
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
    let open_panel = MenuItem::with_id(app, "open_panel", "Open Assistant", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_pet, &open_panel, &quit])?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().expect("application icon").clone())
        .tooltip("Piko Desktop AI Pet")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show_pet" => show_and_focus(app, "pet"),
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
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            configure_tray(app)?;
            configure_global_shortcut(app)?;
            persist_settings(app.handle(), &read_settings(app.handle()));
            restore_pet_position(app.handle());
            watch_pet_position(app.handle());
            enable_pet_background_drag(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            show_bubble,
            hide_bubble,
            open_panel,
            show_pet,
            move_pet,
            get_settings,
            list_chat_history,
            clear_chat_history,
            update_quiet_mode,
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
        extract_chat_deltas, monitor_contains, normalize_base_url, should_bypass_system_proxy,
        AppSettings, ChatEvent,
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
        assert_eq!(AppSettings::default().quiet_mode, "balanced");
    }

    #[test]
    fn normalizes_base_url() {
        assert_eq!(
            normalize_base_url(" http://localhost:11434/v1/ "),
            "http://localhost:11434/v1"
        );
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
}
