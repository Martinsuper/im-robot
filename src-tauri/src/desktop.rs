//! Desktop windows, geometry, tray menus and global shortcuts.
use crate::debounce;
use crate::settings::persist_settings;
use crate::settings::read_settings;
use serde::Deserialize;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::ContextMenu;
use tauri::menu::Menu;
use tauri::menu::MenuItem;
use tauri::menu::PredefinedMenuItem;
#[cfg(target_os = "macos")]
use tauri::menu::Submenu;
use tauri::tray::TrayIconBuilder;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::LogicalPosition;
use tauri::LogicalSize;
use tauri::Manager;
use tauri::PhysicalPosition;
use tauri::PhysicalSize;
use tauri::State;
use tauri::Webview;
use tauri::WindowEvent;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_global_shortcut::Shortcut;
use tauri_plugin_global_shortcut::ShortcutState;

pub(crate) const PET_MARGIN: i32 = 16;

/// How many pixels of the pet window stay visible when tucked at screen edge.
pub(crate) const PET_PEEK: i32 = 40;

pub(crate) const PET_MOVE_DEBOUNCE_MS: u64 = 220;

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct PetPosition {
    pub(crate) x: i32,
    pub(crate) y: i32,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct BubbleSize {
    pub(crate) width: u32,
    pub(crate) height: u32,
}

/// 精灵窗口右键菜单：持有 Menu 实例，避免菜单弹出后被 Drop。
#[derive(Default)]
pub(crate) struct PetContextMenu(pub(crate) Mutex<Option<Menu<tauri::Wry>>>);

pub(crate) fn pet_position_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("pet-position.json"))
}

pub(crate) fn bubble_size_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("bubble-size.json"))
}

pub(crate) fn persist_pet_position(app: &AppHandle, position: PhysicalPosition<i32>) {
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

pub(crate) fn persist_bubble_size(app: &AppHandle, size: PhysicalSize<u32>) {
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

pub(crate) fn monitor_contains(
    monitor_position: PhysicalPosition<i32>,
    monitor_size: tauri::PhysicalSize<u32>,
    position: PhysicalPosition<i32>,
) -> bool {
    position.x >= monitor_position.x
        && position.y >= monitor_position.y
        && position.x < monitor_position.x + monitor_size.width as i32
        && position.y < monitor_position.y + monitor_size.height as i32
}

pub(crate) fn clamp_pet_physical_position(
    requested: PhysicalPosition<i32>,
    window_size: PhysicalSize<u32>,
    work_area_position: PhysicalPosition<i32>,
    work_area_size: PhysicalSize<u32>,
    peek: i32,
) -> PhysicalPosition<i32> {
    let x = requested
        .x
        .max(work_area_position.x - window_size.width as i32 + peek)
        .min(work_area_position.x + work_area_size.width as i32 - peek);
    let y = requested
        .y
        .max(work_area_position.y - window_size.height as i32 + peek)
        .min(work_area_position.y + work_area_size.height as i32 - peek);
    PhysicalPosition::new(x, y)
}

pub(crate) fn restore_pet_position(app: &AppHandle) {
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
    let Ok(monitors) = window.available_monitors() else {
        return;
    };
    let Ok(window_size) = window.outer_size() else {
        return;
    };
    let peek = window
        .scale_factor()
        .map(|scale| (PET_PEEK as f64 * scale).round() as i32)
        .unwrap_or(PET_PEEK)
        .max(1);
    let Some(monitor) = monitors
        .iter()
        .find(|monitor| monitor_contains(*monitor.position(), *monitor.size(), position))
        .or_else(|| monitors.first())
    else {
        return;
    };
    let work_area = monitor.work_area();
    let clamped = clamp_pet_physical_position(
        position,
        window_size,
        work_area.position,
        work_area.size,
        peek,
    );
    let _ = window.set_position(clamped);
}

pub(crate) fn show_pet_on_startup(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("pet") {
        let _ = window.unminimize();
        let _ = window.show();
    }
}

pub(crate) fn save_current_pet_position(app: &AppHandle) {
    let Some(window) = app.get_webview_window("pet") else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    persist_pet_position(app, position);
}

pub(crate) fn restore_bubble_size(app: &AppHandle) {
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

pub(crate) fn save_current_bubble_size(app: &AppHandle) {
    if WORKSPACE_VISIBLE.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    let Some(window) = app.get_webview_window("bubble") else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    persist_bubble_size(app, size);
}

pub(crate) fn clamp_pet_position(
    requested: LogicalPosition<f64>,
    window_size: LogicalSize<f64>,
    work_area_position: LogicalPosition<f64>,
    work_area_size: LogicalSize<f64>,
) -> LogicalPosition<f64> {
    let peek = PET_PEEK as f64;
    let x = requested
        .x
        .max(work_area_position.x - window_size.width + peek)
        .min(work_area_position.x + work_area_size.width - peek);
    let y = requested
        .y
        .max(work_area_position.y - window_size.height + peek)
        .min(work_area_position.y + work_area_size.height - peek);
    LogicalPosition::new(x, y)
}

fn distance_to_work_area(
    point: LogicalPosition<f64>,
    origin: LogicalPosition<f64>,
    size: LogicalSize<f64>,
) -> f64 {
    let dx = point.x - point.x.clamp(origin.x, origin.x + size.width);
    let dy = point.y - point.y.clamp(origin.y, origin.y + size.height);
    dx * dx + dy * dy
}

// Snap the visible character, rather than the transparent window padding.
fn snap_pet_position(
    mut position: LogicalPosition<f64>,
    size: LogicalSize<f64>,
    origin: LogicalPosition<f64>,
    area: LogicalSize<f64>,
    insets: [f64; 4],
) -> LogicalPosition<f64> {
    let [left, top, right, bottom] = insets;
    let targets_x = [
        origin.x - left + 8.0,
        origin.x + area.width - size.width + right - 8.0,
    ];
    let targets_y = [
        origin.y - top + 8.0,
        origin.y + area.height - size.height + bottom - 8.0,
    ];
    for (coordinate, targets) in [(&mut position.x, targets_x), (&mut position.y, targets_y)] {
        let target = targets
            .into_iter()
            .min_by(|a, b| (*coordinate - a).abs().total_cmp(&(*coordinate - b).abs()))
            .unwrap();
        if (*coordinate - target).abs() <= 64.0 {
            *coordinate = target;
        }
    }
    position
}

#[tauri::command]
pub(crate) fn move_pet(
    app: AppHandle,
    x: f64,
    y: f64,
    snap_insets: Option<[f64; 4]>,
) -> Result<(f64, f64), String> {
    let window = app
        .get_webview_window("pet")
        .ok_or_else(|| "pet window not found".to_string())?;
    let requested = LogicalPosition::new(x.round(), y.round());
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let scale_factor = window.scale_factor().map_err(|e| e.to_string())?;
    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    let logical_size = size.to_logical::<f64>(scale_factor);
    let center = LogicalPosition::new(
        requested.x + logical_size.width / 2.0,
        requested.y + logical_size.height / 2.0,
    );
    // Nearest work area also handles dragging into a dock/menu-bar gap on a
    // secondary display; falling back to the first monitor would jump screens.
    let distance = |monitor: &tauri::Monitor| {
        let area = monitor.work_area();
        distance_to_work_area(
            center,
            area.position.to_logical::<f64>(scale_factor),
            area.size.to_logical::<f64>(scale_factor),
        )
    };
    let Some(monitor) = monitors
        .iter()
        .min_by(|a, b| distance(a).total_cmp(&distance(b)))
    else {
        window.set_position(requested).map_err(|e| e.to_string())?;
        return Ok((requested.x, requested.y));
    };
    let area = monitor.work_area();
    let mut position = clamp_pet_position(
        requested,
        size.to_logical::<f64>(scale_factor),
        area.position.to_logical::<f64>(scale_factor),
        area.size.to_logical::<f64>(scale_factor),
    );
    if let Some(insets) = snap_insets {
        position = snap_pet_position(
            position,
            size.to_logical::<f64>(scale_factor),
            area.position.to_logical::<f64>(scale_factor),
            area.size.to_logical::<f64>(scale_factor),
            insets,
        );
    }
    window.set_position(position).map_err(|e| e.to_string())?;
    Ok((position.x, position.y))
}

#[tauri::command]
pub(crate) fn move_pet_relative(app: AppHandle, dx: f64, dy: f64) -> Result<(f64, f64), String> {
    let window = app
        .get_webview_window("pet")
        .ok_or_else(|| "pet window not found".to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let scale_factor = window.scale_factor().map_err(|e| e.to_string())?;
    let logical_pos: LogicalPosition<f64> = pos.to_logical::<f64>(scale_factor);
    move_pet(app, logical_pos.x + dx, logical_pos.y + dy, None)
}

#[tauri::command]
pub(crate) fn get_pet_position(app: AppHandle) -> Result<(f64, f64), String> {
    let window = app
        .get_webview_window("pet")
        .ok_or("pet window not found")?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let scale_factor = window.scale_factor().map_err(|e| e.to_string())?;
    let logical_pos: LogicalPosition<f64> = pos.to_logical::<f64>(scale_factor);
    Ok((logical_pos.x, logical_pos.y))
}

pub(crate) fn place_bubble_near_pet(app: &AppHandle) {
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

pub(crate) fn watch_pet_position(app: &AppHandle) {
    let Some(window) = app.get_webview_window("pet") else {
        return;
    };
    let app = app.clone();
    let debounce =
        debounce::Debouncer::new(Duration::from_millis(PET_MOVE_DEBOUNCE_MS), move || {
            save_current_pet_position(&app)
        });
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Moved(_)) {
            debounce.trigger();
        }
    });
}

pub(crate) fn watch_bubble_resize(app: &AppHandle) {
    let Some(window) = app.get_webview_window("bubble") else {
        return;
    };
    let app = app.clone();
    let debounce =
        debounce::Debouncer::new(Duration::from_millis(PET_MOVE_DEBOUNCE_MS), move || {
            save_current_bubble_size(&app)
        });
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Resized(_)) {
            debounce.trigger();
        }
    });
}

pub(crate) fn watch_panel_close(app: &AppHandle) {
    watch_bubble_close(app);
    let Some(panel) = app.get_webview_window("panel") else {
        return;
    };
    let app = app.clone();

    panel.on_window_event(move |event| {
        let WindowEvent::CloseRequested { api, .. } = event else {
            return;
        };
        api.prevent_close();
        if let Some(panel) = app.get_webview_window("panel") {
            let _ = panel.hide();
        }
        let pet_is_visible = app
            .get_webview_window("pet")
            .and_then(|pet| pet.is_visible().ok())
            .unwrap_or(false);
        if !pet_is_visible {
            show_and_focus(&app, "pet");
        }
    });
}

/// Keep quick chat alive when its native close button is used, preserving tasks and drafts.
fn watch_bubble_close(app: &AppHandle) {
    let Some(bubble) = app.get_webview_window("bubble") else {
        return;
    };
    let app = app.clone();
    bubble.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Some(bubble) = app.get_webview_window("bubble") {
                let _ = bubble.hide();
            }
        }
    });
}

#[cfg(target_os = "macos")]
pub(crate) fn enable_pet_background_drag(app: &AppHandle) {
    let Some(window) = app.get_webview_window("pet") else {
        return;
    };

    let _ = window.with_webview(|webview| unsafe {
        let ns_window: &objc2_app_kit::NSWindow = &*webview.ns_window().cast();
        ns_window.setMovableByWindowBackground(false);
    });
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn enable_pet_background_drag(_app: &AppHandle) {}

#[cfg(target_os = "macos")]
pub(crate) fn enable_bubble_background_drag(_app: &AppHandle) {}

#[cfg(not(target_os = "macos"))]
pub(crate) fn enable_bubble_background_drag(_app: &AppHandle) {}

pub(crate) fn show_and_focus(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        // Only anchor a hidden quick surface. Never move an already visible or
        // expanded conversation while the user is working in it.
        if label == "bubble"
            && !window.is_visible().unwrap_or(false)
            && !window.is_decorated().unwrap_or(true)
        {
            place_bubble_near_pet(app);
        }
        let _ = window.unminimize();
        if window.show().is_ok() {
            let _ = window.set_focus();
        }
    }
}

#[tauri::command]
pub(crate) fn show_bubble(app: AppHandle) {
    show_and_focus(&app, "bubble");
}

#[tauri::command]
pub(crate) fn hide_bubble(app: AppHandle) {
    if let Some(window) = app.get_webview_window("bubble") {
        let _ = window.hide();
    }
}

#[tauri::command]
pub(crate) fn toggle_bubble(app: AppHandle) {
    if let Some(window) = app.get_webview_window("bubble") {
        if window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false) {
            let _ = window.hide();
        } else {
            show_and_focus(&app, "bubble");
        }
    }
}

static PENDING_WORKSPACE: Mutex<Option<Option<String>>> = Mutex::new(None);
static WORKSPACE_VISIBLE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Do not persist the temporary two-column size as the next quick-chat size.
pub(crate) fn set_workspace_visible(visible: bool) {
    WORKSPACE_VISIBLE.store(visible, std::sync::atomic::Ordering::Relaxed);
}

/// Replay an entry requested before the conversation WebView finished subscribing.
pub(crate) fn replay_workspace_request(app: &AppHandle) {
    if let Ok(mut pending) = PENDING_WORKSPACE.lock() {
        if let Some(tab) = pending.take() {
            let _ = app.emit_to("bubble", "workspace-open", tab);
        }
    }
}

#[tauri::command]
pub(crate) fn open_panel(app: AppHandle, tab: Option<String>) {
    show_and_focus(&app, "bubble");
    let tab = tab.filter(|tab| matches!(tab.as_str(), "today" | "records" | "settings"));
    if let Ok(mut pending) = PENDING_WORKSPACE.lock() {
        *pending = Some(tab.clone());
    }
    let _ = app.emit_to("bubble", "workspace-open", tab);
}

#[tauri::command]
pub(crate) fn toggle_panel(app: AppHandle) {
    open_panel(app, None);
}

#[tauri::command]
pub(crate) fn show_pet(app: AppHandle) {
    set_pet_visible(&app, true);
}

#[tauri::command]
pub(crate) fn hide_pet(app: AppHandle) {
    set_pet_visible(&app, false);
}

#[tauri::command]
pub(crate) fn show_pet_context_menu(app: AppHandle) -> Result<(), String> {
    // `Manager::get_window` 需要 tauri 的 unstable feature；
    // WebviewWindow 只 AsRef<Webview>，从 Webview::window() 拿到宿主 Window。
    let window = app
        .get_webview_window("pet")
        .as_ref()
        .map(|webview_window| AsRef::<Webview<_>>::as_ref(webview_window).window())
        .ok_or_else(|| "宠物窗口不存在".to_string())?;

    let chat_item = MenuItem::with_id(&app, "pet_ctx_chat", "对话", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let panel_item = MenuItem::with_id(&app, "pet_ctx_panel", "打开面板", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let hide_item = MenuItem::with_id(&app, "pet_ctx_hide", "隐藏", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit_item = MenuItem::with_id(&app, "pet_ctx_quit", "退出", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let separator = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(
        &app,
        &[&chat_item, &panel_item, &separator, &hide_item, &quit_item],
    )
    .map_err(|e| e.to_string())?;

    // 菜单必须在 popup 之后继续存活，否则 macOS 上会立刻消失。
    // 注意：Manager::manage 对已存在的类型不会覆盖，所以这里用 State slot 替换。
    let store = app.state::<PetContextMenu>();
    {
        let mut slot = store.0.lock().map_err(|_| "无法准备右键菜单".to_string())?;
        *slot = Some(menu);
    }
    let guard = store.0.lock().map_err(|_| "无法准备右键菜单".to_string())?;
    if let Some(menu) = guard.as_ref() {
        // 观测点：菜单不弹时很难分辨是「右键事件没到」还是「popup 失败」，两条都留。
        //
        // 注意 `popup()` 在 macOS 上是**阻塞**的：它跑一个嵌套事件循环，直到菜单被关闭
        // 才返回。已实测——把日志打在 popup 之后，它只在点击菜单项之后才出现。
        // 因此：
        //  - 「弹出中」必须打在 popup 之前；
        //  - 上面那把 Mutex guard 会横跨整个菜单生命期。这里没有死锁风险，
        //    因为菜单是模态的，期间不会有第二次调用。
        println!("[pet-menu] 弹出右键菜单：对话 / 打开面板 / 隐藏 / 退出");
        match menu.popup(window) {
            Ok(()) => println!("[pet-menu] 菜单已关闭"),
            Err(error) => eprintln!("[pet-menu] 弹出右键菜单失败：{error}"),
        }
    }

    Ok(())
}

/// 托盘菜单项句柄（R4-1 状态感知），用于在运行时改文案。
pub(crate) struct TrayState {
    pub(crate) toggle_label: Mutex<MenuItem<tauri::Wry>>,
}

/// `TrayIcon` 是引用计数的：**最后一个实例被 drop 时图标就会从菜单栏消失**
/// （tauri tray/mod.rs:394）。必须把它存进 managed state，否则
/// `TrayIconBuilder::build()` 返回值一被丢弃，托盘就没了——
/// 这正是「日志说创建成功、菜单栏却看不到图标」的原因。
pub(crate) struct TrayIconHandle {
    pub(crate) _icon: tauri::tray::TrayIcon<tauri::Wry>,
}

/// 当前生效的全局快捷键（R4-2），供设置页展示。
pub(crate) struct GlobalShortcutState(pub(crate) Mutex<String>);

/// 切换精灵可见性，并同步托盘菜单文案（R4-1 状态感知）。
///
/// 托盘菜单项在 build 时创建，Tauri 没有给「菜单即将显示」的钩子，
/// 所以把可见性切换收敛到这一个函数里，在这里同步改菜单文字。
pub(crate) fn set_pet_visible(app: &AppHandle, visible: bool) {
    if let Some(window) = app.get_webview_window("pet") {
        let _ = if visible {
            window.show()
        } else {
            window.hide()
        };
        if visible {
            let _ = window.set_focus();
        }
    }
    if let Some(state) = app.try_state::<TrayState>() {
        if let Ok(label) = state.toggle_label.lock() {
            let text = if visible {
                "隐藏桌面伙伴"
            } else {
                "显示桌面伙伴"
            };
            let _ = label.set_text(text);
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn configure_application_menu(app: &tauri::App) -> tauri::Result<()> {
    let menu = Menu::default(app.handle())?;
    let chat = MenuItem::with_id(app, "pet_ctx_chat", "对话", true, None::<&str>)?;
    let panel = MenuItem::with_id(app, "pet_ctx_panel", "主面板", true, None::<&str>)?;
    let actions = Submenu::with_items(app, "Piko 操作", true, &[&chat, &panel])?;
    menu.append(&actions)?;
    app.set_menu(menu)?;
    Ok(())
}

pub(crate) fn configure_tray(
    app: &tauri::App,
) -> Result<(MenuItem<tauri::Wry>, tauri::tray::TrayIcon<tauri::Wry>), Box<dyn std::error::Error>> {
    let show_pet = MenuItem::with_id(app, "toggle_pet", "隐藏桌面伙伴", true, None::<&str>)?;
    let open_chat = MenuItem::with_id(app, "open_chat", "与 Piko 对话…", true, None::<&str>)?;
    let capture = MenuItem::with_id(app, "tray_capture", "截图提问…", true, None::<&str>)?;
    let open_panel = MenuItem::with_id(app, "open_panel", "今天与待办…", true, None::<&str>)?;
    let records = MenuItem::with_id(app, "open_records", "记录与回忆…", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "open_settings", "设置…", true, Some("CmdOrCtrl+,"))?;
    let quit = MenuItem::with_id(app, "quit", "退出 Piko", true, Some("CmdOrCtrl+Q"))?;
    let separator1 = PredefinedMenuItem::separator(app)?;
    let separator2 = PredefinedMenuItem::separator(app)?;
    let separator3 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &open_chat,
            &capture,
            &separator1,
            &open_panel,
            &records,
            &settings,
            &separator2,
            &show_pet,
            &separator3,
            &quit,
        ],
    )?;
    let tray_icon = TrayIconBuilder::new()
        .icon(app.default_window_icon().expect("application icon").clone())
        .tooltip("Piko · 点击打开对话与快捷操作")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle_pet" => {
                let visible = app
                    .get_webview_window("pet")
                    .and_then(|window| window.is_visible().ok())
                    .unwrap_or(false);
                set_pet_visible(app, !visible);
            }
            "open_chat" => show_and_focus(app, "bubble"),
            "tray_capture" => {
                show_and_focus(app, "bubble");
                let _ = app.emit_to("bubble", "bubble-capture-requested", ());
            }
            "open_panel" => self::open_panel(app.clone(), Some("today".into())),
            "open_records" => self::open_panel(app.clone(), Some("records".into())),
            "open_settings" => self::open_panel(app.clone(), Some("settings".into())),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    println!("[tray] 托盘快捷菜单已创建");
    Ok((show_pet, tray_icon))
}

/// 把 "CmdOrCtrl+Shift+Space" 这类字符串解析成 `Shortcut`（R4-2）。
///
/// 解析失败返回 Err，由调用方决定如何提示；绝不静默回退到默认值——
/// 否则用户改了个坏值，界面显示的是新值，实际生效的却是旧值。
pub(crate) fn parse_global_shortcut(value: &str) -> Result<Shortcut, String> {
    use std::str::FromStr;
    // 插件自带的解析器支持 "CmdOrCtrl+Shift+Space" / "Alt+X" 等写法
    Shortcut::from_str(value)
        .map_err(|_| format!("快捷键格式看不懂：{value}。请用类似 CmdOrCtrl+Shift+Space 的写法"))
}

/// 注册全局快捷键（R4-2：从设置读取，不再硬编码）。
pub(crate) fn configure_global_shortcut(
    app: &tauri::App,
) -> Result<(), Box<dyn std::error::Error>> {
    let settings = read_settings(app.handle());
    let shortcut = parse_global_shortcut(&settings.global_shortcut)?;

    app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, registered, event| {
                if registered == &shortcut && event.state() == ShortcutState::Pressed {
                    show_and_focus(app, "bubble");
                }
            })
            .build(),
    )?;

    app.global_shortcut().register(shortcut).map_err(|error| {
        // 02 §12 / 06：注册失败要给人话原因（多半是冲突）
        eprintln!("[shortcut] 全局快捷键注册失败：{error}");
        Box::new(error) as Box<dyn std::error::Error>
    })?;
    Ok(())
}

/// 修改全局快捷键（R4-2）。失败时返回人话原因，并说明是否与其他应用冲突。
#[tauri::command]
pub(crate) fn update_global_shortcut(
    app: AppHandle,
    global_shortcut: State<'_, GlobalShortcutState>,
    shortcut: String,
) -> Result<(), String> {
    let new_shortcut = parse_global_shortcut(&shortcut)?;

    // 先注销旧的，再尝试注册新的；失败则把旧的注册回来（回滚）。
    let _ = app.global_shortcut().unregister_all();
    if let Err(error) = app.global_shortcut().register(new_shortcut) {
        let rollback = read_settings(&app).global_shortcut.clone();
        if let Ok(previous) = parse_global_shortcut(&rollback) {
            let _ = app.global_shortcut().register(previous);
        }
        let message = format!("快捷键注册失败，已恢复原快捷键。多半是被别的应用占用了（{error}）");
        return Err(message);
    }

    let mut settings = read_settings(&app);
    settings.global_shortcut = shortcut.clone();
    persist_settings(&app, &settings)?;
    *global_shortcut
        .0
        .lock()
        .map_err(|_| "无法保存快捷键状态".to_string())? = shortcut;
    let _ = app.emit("settings-updated", ());
    Ok(())
}

/// 当前生效的快捷键（供设置页展示）。
#[tauri::command]
pub(crate) fn get_global_shortcut(
    app: AppHandle,
    global_shortcut: State<'_, GlobalShortcutState>,
) -> String {
    global_shortcut
        .0
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| read_settings(&app).global_shortcut)
}

#[cfg(test)]
mod pet_snap_tests {
    use super::*;

    #[test]
    fn monitor_gaps_choose_the_nearest_display() {
        let point = LogicalPosition::new(-720.0, 10.0);
        let secondary = distance_to_work_area(
            point,
            LogicalPosition::new(-1440.0, 24.0),
            LogicalSize::new(1440.0, 876.0),
        );
        let primary = distance_to_work_area(
            point,
            LogicalPosition::new(0.0, 24.0),
            LogicalSize::new(1440.0, 876.0),
        );
        assert!(secondary < primary);
    }

    #[test]
    fn snaps_visible_pet_on_scaled_or_offset_displays_and_leaves_center_free() {
        let origin = LogicalPosition::new(-1440.0, 24.0);
        let area = LogicalSize::new(1440.0, 876.0);
        let size = LogicalSize::new(260.0, 300.0);
        let insets = [63.0, 94.0, 63.0, 46.0];
        let left = snap_pet_position(
            LogicalPosition::new(-1450.0, 300.0),
            size,
            origin,
            area,
            insets,
        );
        assert_eq!((left.x, left.y), (-1495.0, 300.0));
        let bottom_right = snap_pet_position(
            LogicalPosition::new(-210.0, 625.0),
            size,
            origin,
            area,
            insets,
        );
        assert_eq!((bottom_right.x, bottom_right.y), (-205.0, 638.0));
        let center = snap_pet_position(
            LogicalPosition::new(-800.0, 300.0),
            size,
            origin,
            area,
            insets,
        );
        assert_eq!((center.x, center.y), (-800.0, 300.0));
    }
}
