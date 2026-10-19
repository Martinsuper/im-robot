//! Idle detection, foreground sensing and ambient event watchers.
use crate::app_awareness;
use crate::app_settings::AppSettings;
use crate::rhythm::emit_work_rhythm_updated;
use crate::rhythm::FocusTimer;
use crate::runtime_types::ChatRequests;
use crate::runtime_types::PetVisualEvent;
use crate::settings::read_settings;
use serde_json::json;
#[cfg(target_os = "linux")]
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;

#[derive(Default)]
pub(crate) struct IdleDetection(pub(crate) Mutex<bool>);

pub(crate) fn watch_ambient_nudges(app: &AppHandle) {
    let app = app.clone();
    crate::background::SUPERVISOR.spawn("ambient-nudges", move |worker| {
        while !worker.cancelled() {
            let settings = read_settings(&app);
            let delay = match settings.quiet_mode.as_str() {
                "active" => 45,
                "minimal" => 300,
                _ => 120,
            };
            if !worker.wait(Duration::from_secs(delay)) {
                break;
            }
            if !settings.sensing_paused && settings.quiet_mode != "minimal" {
                let _ = app.emit_to("pet", "pet-visual-event", PetVisualEvent::AmbientNudge);
            }
        }
        Ok(())
    });
}

pub(crate) fn idle_threshold_seconds(quiet_mode: &str) -> u64 {
    match quiet_mode {
        "active" => 60,
        "minimal" => 300,
        _ => 120,
    }
}

pub(crate) fn next_idle_state(
    was_idle: bool,
    settings: &AppSettings,
    idle_seconds: u64,
    is_busy: bool,
) -> (bool, Option<PetVisualEvent>) {
    let should_rest = !settings.sensing_paused
        && !is_busy
        && idle_seconds >= idle_threshold_seconds(&settings.quiet_mode);

    match (was_idle, should_rest, is_busy) {
        (false, true, _) => (true, Some(PetVisualEvent::IdleStarted)),
        (true, false, false) => (false, Some(PetVisualEvent::IdleEnded)),
        (true, false, true) => (false, None),
        _ => (was_idle, None),
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn system_idle_seconds() -> Option<u64> {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state_id: i32, event_type: u32) -> f64;
    }

    const HID_SYSTEM_STATE: i32 = 1;
    const ANY_INPUT_EVENT_TYPE: u32 = u32::MAX;
    let seconds =
        unsafe { CGEventSourceSecondsSinceLastEventType(HID_SYSTEM_STATE, ANY_INPUT_EVENT_TYPE) };
    seconds.is_finite().then_some(seconds.max(0.0) as u64)
}

#[cfg(target_os = "windows")]
pub(crate) fn system_idle_seconds() -> Option<u64> {
    #[repr(C)]
    struct LastInputInfo {
        size: u32,
        tick_count: u32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetLastInputInfo(info: *mut LastInputInfo) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetTickCount() -> u32;
    }

    let mut info = LastInputInfo {
        size: std::mem::size_of::<LastInputInfo>() as u32,
        tick_count: 0,
    };
    if unsafe { GetLastInputInfo(&mut info) } == 0 {
        return None;
    }
    Some(unsafe { GetTickCount() }.wrapping_sub(info.tick_count) as u64 / 1000)
}

#[cfg(target_os = "linux")]
pub(crate) fn system_idle_seconds() -> Option<u64> {
    Command::new("xprintidle")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|milliseconds| milliseconds.trim().parse::<u64>().ok())
        .map(|milliseconds| milliseconds / 1000)
}

pub(crate) fn watch_idle_detection(app: &AppHandle) {
    let app = app.clone();
    crate::background::SUPERVISOR.spawn("idle-detection", move |worker| {
        while !worker.cancelled() {
            if let Some(idle_seconds) = system_idle_seconds() {
                let settings = read_settings(&app);
                let chat_is_active = app
                    .state::<ChatRequests>()
                    .0
                    .lock()
                    .map(|requests| !requests.is_empty())
                    .unwrap_or(false);
                let focus_is_active = app.state::<FocusTimer>().is_active();
                let idle = app.state::<IdleDetection>();
                if let Ok(mut was_idle) = idle.0.lock() {
                    let (is_idle, event) = next_idle_state(
                        *was_idle,
                        &settings,
                        idle_seconds,
                        chat_is_active || focus_is_active,
                    );
                    *was_idle = is_idle;
                    if let Some(event) = event {
                        let _ = app.emit_to("pet", "pet-visual-event", event);
                    }
                };
            }
            if !worker.wait(Duration::from_secs(2)) {
                break;
            }
        }
        Ok(())
    });
}

/// Watch the foreground application and update pet behavior accordingly.
pub(crate) fn watch_foreground_app(app: &AppHandle) {
    let app = app.clone();
    crate::background::SUPERVISOR.spawn("foreground-app", move |worker| {
        while !worker.cancelled() {
            if let Some(name) = app_awareness::get_foreground_app_name() {
                let category = app_awareness::classify(&name);
                let state = app.state::<app_awareness::ForegroundAppState>();

                // Update state
                if let Ok(mut cat) = state.current_category.lock() {
                    *cat = category;
                }
                if let Ok(mut last) = state.last_app_name.lock() {
                    *last = Some(name.clone());
                }

                // Check if sensing is paused
                let paused = state.sensing_paused.lock().map(|p| *p).unwrap_or(false);
                if !paused {
                    let _ = app.emit_to(
                        "pet",
                        "foreground-app-changed",
                        json!({
                            "category": format!("{category}"),
                            "appName": name,
                        }),
                    );
                }
                emit_work_rhythm_updated(&app);
            }
            if !worker.wait(Duration::from_secs(5)) {
                break;
            }
        }
        Ok(())
    });
}
