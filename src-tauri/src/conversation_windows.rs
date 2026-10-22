//! Native presentation windows never own or cancel agent processes.
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversationWindow {
    pub conversation_id: String,
    pub title: String,
    pub width: f64,
    pub height: f64,
    pub x: Option<f64>,
    pub y: Option<f64>,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowSnapshot {
    pub revision: u64,
    pub windows: Vec<ConversationWindow>,
}
#[derive(Default)]
struct Registry {
    revision: u64,
    windows: HashMap<String, ConversationWindow>,
    closing: HashSet<String>,
    shutting_down: bool,
}
#[derive(Default)]
pub(crate) struct ConversationWindows(Mutex<Registry>);
fn label(id: &str) -> String {
    format!("conversation-{id}")
}
fn snapshot(registry: &Registry) -> WindowSnapshot {
    let mut windows: Vec<_> = registry.windows.values().cloned().collect();
    windows.sort_by(|a, b| a.conversation_id.cmp(&b.conversation_id));
    WindowSnapshot {
        revision: registry.revision,
        windows,
    }
}
fn file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("conversation-windows.json"))
}
fn persist(app: &AppHandle, registry: &Registry) -> Result<(), String> {
    crate::storage::write(&file(app)?, &snapshot(registry).windows)
}
fn publish(app: &AppHandle, registry: &Registry) {
    let _ = app.emit("conversation-windows-changed", snapshot(registry));
}
pub(crate) fn is_open(app: &AppHandle, id: &str) -> bool {
    app.state::<ConversationWindows>()
        .0
        .lock()
        .map(|r| r.windows.contains_key(id))
        .unwrap_or(true)
}
fn remember_geometry(app: &AppHandle, id: &str) {
    let Some(window) = app.get_webview_window(&label(id)) else {
        return;
    };
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let (Ok(size), Ok(position)) = (window.inner_size(), window.outer_position()) else {
        return;
    };
    let state = app.state::<ConversationWindows>();
    if let Ok(mut registry) = state.0.lock() {
        if let Some(record) = registry.windows.get_mut(id) {
            record.width = size.width as f64 / scale;
            record.height = size.height as f64 / scale;
            record.x = Some(position.x as f64 / scale);
            record.y = Some(position.y as f64 / scale);
        }
        if let Err(error) = persist(app, &registry) {
            eprintln!("[conversation-windows] {error}");
        }
    };
}
fn finish_close(app: &AppHandle, id: &str) -> Result<(), String> {
    remember_geometry(app, id);
    let Some(window) = app.get_webview_window(&label(id)) else {
        return Ok(());
    };
    {
        let state = app.state::<ConversationWindows>();
        let mut registry = state.0.lock().map_err(|_| "无法关闭会话窗口")?;
        registry.closing.insert(id.into());
    }
    window.close().map_err(|e| e.to_string())
}
fn open_window(app: &AppHandle, mut record: ConversationWindow) -> Result<WindowSnapshot, String> {
    let id = record.conversation_id.clone();
    if !crate::conversation_views::valid_id(&id) {
        return Err("无效的会话标识".into());
    }
    if app
        .state::<crate::screen_capture::ScreenCaptureStore>()
        .1
        .lock()
        .map_err(|_| "无法读取截图状态")?
        .is_some()
    {
        return Err("请先完成或取消截图，再打开独立窗口。".into());
    }
    let window_label = label(&id);
    if let Some(window) = app.get_webview_window(&window_label) {
        window.show().map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return conversation_list_windows(app.state());
    }
    record.title = record.title.chars().take(48).collect();
    record.width = if record.width.is_finite() {
        record.width.clamp(480.0, 2000.0)
    } else {
        760.0
    };
    record.height = if record.height.is_finite() {
        record.height.clamp(420.0, 1600.0)
    } else {
        760.0
    };
    // Bring restored windows back onto the current primary display.
    if let Some(monitor) = app
        .get_webview_window("bubble")
        .and_then(|w| w.primary_monitor().ok().flatten())
    {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let (x, y) = (
            area.position.x as f64 / scale,
            area.position.y as f64 / scale,
        );
        let (width, height) = (
            area.size.width as f64 / scale,
            area.size.height as f64 / scale,
        );
        record.width = record.width.min(width);
        record.height = record.height.min(height);
        record.x = record
            .x
            .filter(|v| v.is_finite())
            .map(|v| v.clamp(x, x + (width - record.width).max(0.0)));
        record.y = record
            .y
            .filter(|v| v.is_finite())
            .map(|v| v.clamp(y, y + (height - record.height).max(0.0)));
    }
    {
        let state = app.state::<ConversationWindows>();
        let mut registry = state.0.lock().map_err(|_| "无法打开会话窗口")?;
        if registry.windows.contains_key(&id) {
            return Err("会话窗口正在打开，请稍后重试".into());
        }
        if registry.windows.len() >= 12 {
            return Err("最多打开 12 个独立会话窗口".into());
        }
        registry.windows.insert(id.clone(), record.clone());
    }
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        &window_label,
        tauri::WebviewUrl::App(format!("index.html?view=bubble&conversation={id}").into()),
    )
    .on_navigation(crate::html_preview::local_preview_navigation)
    .title(format!("Piko · {}", record.title))
    .inner_size(record.width, record.height)
    .min_inner_size(360.0, 320.0)
    .resizable(true)
    .decorations(true);
    if let (Some(x), Some(y)) = (record.x, record.y) {
        builder = builder.position(x, y);
    } else {
        builder = builder.center();
    }
    let window = match builder.build() {
        Ok(window) => window,
        Err(error) => {
            let state = app.state::<ConversationWindows>();
            let mut registry = state.0.lock().map_err(|_| "无法打开会话窗口")?;
            registry.windows.remove(&id);
            return Err(format!("无法打开独立窗口：{error}"));
        }
    };
    let handle = app.clone();
    let event_id = id.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            let state = handle.state::<ConversationWindows>();
            let registry = state.0.lock().unwrap_or_else(|e| e.into_inner());
            if registry.shutting_down || registry.closing.contains(&event_id) {
                return;
            }
            api.prevent_close();
            drop(registry);
            let _ = handle.emit_to(label(&event_id), "conversation-close-requested", &event_id);
            let fallback = handle.clone();
            let id = event_id.clone();
            crate::background::SUPERVISOR.spawn_async_effect(
                "conversation-close",
                move |worker| async move {
                    if worker.sleep(std::time::Duration::from_secs(2)).await {
                        let _ = finish_close(&fallback, &id);
                    }
                },
            );
        }
        tauri::WindowEvent::Focused(false) => remember_geometry(&handle, &event_id),
        tauri::WindowEvent::Destroyed => {
            let state = handle.state::<ConversationWindows>();
            let mut registry = state.0.lock().unwrap_or_else(|e| e.into_inner());
            if registry.shutting_down {
                return;
            }
            registry.windows.remove(&event_id);
            registry.closing.remove(&event_id);
            registry.revision += 1;
            if let Err(error) = persist(&handle, &registry) {
                eprintln!("[conversation-windows] {error}");
            }
            publish(&handle, &registry);
            drop(registry);
            crate::desktop::show_and_focus(&handle, "bubble");
            let _ = handle.emit_to("bubble", "conversation-returned", &event_id);
        }
        _ => {}
    });
    let state = app.state::<ConversationWindows>();
    let mut registry = state.0.lock().map_err(|_| "无法保存窗口状态")?;
    registry.revision += 1;
    if let Err(error) = persist(app, &registry) {
        eprintln!("[conversation-windows] {error}");
    }
    publish(app, &registry);
    let result = snapshot(&registry);
    drop(registry);
    let _ = window.set_focus();
    Ok(result)
}

#[tauri::command]
pub(crate) fn conversation_list_windows(
    windows: State<'_, ConversationWindows>,
) -> Result<WindowSnapshot, String> {
    let registry = windows.0.lock().map_err(|_| "无法读取窗口状态")?;
    Ok(snapshot(&registry))
}
#[tauri::command]
pub(crate) async fn conversation_open_window(
    app: AppHandle,
    conversation_id: String,
    title: String,
) -> Result<WindowSnapshot, String> {
    let _lease = crate::data_gate::try_read()?;
    open_window(
        &app,
        ConversationWindow {
            conversation_id,
            title,
            width: 760.0,
            height: 760.0,
            x: None,
            y: None,
        },
    )
}
#[tauri::command]
pub(crate) fn conversation_close_window(
    app: AppHandle,
    window: tauri::WebviewWindow,
    conversation_id: String,
) -> Result<(), String> {
    if !crate::conversation_views::valid_id(&conversation_id) {
        return Err("无效的会话标识".into());
    }
    if window.label() == label(&conversation_id) {
        finish_close(&app, &conversation_id)
    } else if let Some(target) = app.get_webview_window(&label(&conversation_id)) {
        target.close().map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}
pub(crate) fn restore(app: &AppHandle) {
    let records = file(app).and_then(|file| crate::storage::read::<Vec<ConversationWindow>>(&file));
    match records {
        Ok(records) => {
            for record in records.into_iter().take(12) {
                if let Err(error) = open_window(app, record) {
                    eprintln!("[conversation-windows] restore: {error}");
                }
            }
        }
        Err(error) => eprintln!("[conversation-windows] restore: {error}"),
    }
}
pub(crate) fn prepare_exit(app: &AppHandle) {
    let state = app.state::<ConversationWindows>();
    let ids: Vec<_> = state
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .windows
        .keys()
        .cloned()
        .collect();
    for id in ids {
        remember_geometry(app, &id);
    }
    let mut registry = state.0.lock().unwrap_or_else(|e| e.into_inner());
    registry.shutting_down = true;
    if let Err(error) = persist(app, &registry) {
        eprintln!("[conversation-windows] exit: {error}");
    }
}
