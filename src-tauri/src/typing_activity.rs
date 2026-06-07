use chrono::TimeZone;
#[cfg(not(target_os = "macos"))]
use rdev::{listen, Event, EventType, Key};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex, thread, time::Duration};
use tauri::{AppHandle, Manager};

const TYPING_SESSION_IDLE_SECONDS: u64 = 5;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TypingStatsToday {
    pub date: String,
    pub typed_characters: u64,
    pub typing_seconds: u64,
    pub updated_at: u64,
}

#[derive(Debug, Default)]
struct TypingSession {
    started_at: Option<u64>,
    last_typing_at: Option<u64>,
}

pub struct TypingActivityState {
    stats: Mutex<TypingStatsToday>,
    session: Mutex<TypingSession>,
    dirty: Mutex<bool>,
    last_flush_at: Mutex<u64>,
}

impl TypingActivityState {
    pub fn new(app: &AppHandle) -> Self {
        let stats = load_typing_stats(app).unwrap_or_else(default_typing_stats_today);
        Self {
            stats: Mutex::new(stats),
            session: Mutex::new(TypingSession::default()),
            dirty: Mutex::new(false),
            last_flush_at: Mutex::new(crate::unix_timestamp()),
        }
    }

    pub fn snapshot(&self, now: u64) -> Result<TypingStatsToday, String> {
        let stats = self
            .stats
            .lock()
            .map_err(|_| "无法读取输入统计".to_string())?;
        let session = self
            .session
            .lock()
            .map_err(|_| "无法读取输入统计会话".to_string())?;
        let mut snapshot = stats.clone();
        if let Some(started_at) = session.started_at {
            let active_seconds = now.saturating_sub(started_at).saturating_add(1);
            snapshot.typing_seconds = snapshot.typing_seconds.saturating_add(active_seconds);
        }
        Ok(snapshot)
    }

    pub fn record_keypress(
        &self,
        app: &AppHandle,
        delta: i64,
    ) -> Result<Option<TypingStatsToday>, String> {
        if delta == 0 {
            return Ok(None);
        }
        if is_sensing_paused(app) {
            return Ok(None);
        }

        let now = crate::unix_timestamp();
        self.roll_day_if_needed(app, now)?;

        {
            let mut stats = self
                .stats
                .lock()
                .map_err(|_| "无法更新输入统计".to_string())?;
            if delta > 0 {
                stats.typed_characters = stats.typed_characters.saturating_add(delta as u64);
            } else {
                stats.typed_characters = stats.typed_characters.saturating_sub((-delta) as u64);
            }
            stats.updated_at = now;
        }

        {
            let mut session = self
                .session
                .lock()
                .map_err(|_| "无法更新输入统计会话".to_string())?;
            if session.started_at.is_none() {
                session.started_at = Some(now);
            }
            session.last_typing_at = Some(now);
        }

        {
            let mut dirty = self
                .dirty
                .lock()
                .map_err(|_| "无法更新输入统计状态".to_string())?;
            *dirty = true;
        }

        self.snapshot(now).map(Some)
    }

    pub fn finalize_stale_session(&self, app: &AppHandle, now: u64) -> Result<bool, String> {
        self.roll_day_if_needed(app, now)?;
        let mut stats = self
            .stats
            .lock()
            .map_err(|_| "无法更新输入统计".to_string())?;
        let mut session = self
            .session
            .lock()
            .map_err(|_| "无法读取输入统计会话".to_string())?;
        let Some(started_at) = session.started_at else {
            return Ok(false);
        };
        let last_typing_at = session.last_typing_at.unwrap_or(started_at);
        if now.saturating_sub(last_typing_at) < TYPING_SESSION_IDLE_SECONDS {
            return Ok(false);
        }

        let session_seconds = last_typing_at.saturating_sub(started_at).saturating_add(1);
        stats.typing_seconds = stats.typing_seconds.saturating_add(session_seconds);
        stats.updated_at = now;
        persist_typing_stats(app, &stats)?;
        if let Ok(mut dirty) = self.dirty.lock() {
            *dirty = false;
        }
        if let Ok(mut last_flush_at) = self.last_flush_at.lock() {
            *last_flush_at = now;
        }
        session.started_at = None;
        session.last_typing_at = None;
        Ok(true)
    }

    pub fn flush_snapshot_if_needed(&self, app: &AppHandle, now: u64) -> Result<bool, String> {
        self.roll_day_if_needed(app, now)?;
        let should_flush = {
            let dirty = self
                .dirty
                .lock()
                .map_err(|_| "无法读取输入统计状态".to_string())?;
            if !*dirty {
                return Ok(false);
            }
            let last_flush_at = self
                .last_flush_at
                .lock()
                .map_err(|_| "无法读取输入统计刷新时间".to_string())?;
            now.saturating_sub(*last_flush_at) >= 10
        };
        if !should_flush {
            return Ok(false);
        }

        let snapshot = self.snapshot(now)?;
        persist_typing_stats(app, &snapshot)?;
        if let Ok(mut dirty) = self.dirty.lock() {
            *dirty = false;
        }
        if let Ok(mut last_flush_at) = self.last_flush_at.lock() {
            *last_flush_at = now;
        }
        Ok(true)
    }

    fn roll_day_if_needed(&self, app: &AppHandle, now: u64) -> Result<(), String> {
        let today = current_day_key(now);
        let mut stats = self
            .stats
            .lock()
            .map_err(|_| "无法读取输入统计".to_string())?;
        if stats.date == today {
            return Ok(());
        }

        {
            let mut session = self
                .session
                .lock()
                .map_err(|_| "无法读取输入统计会话".to_string())?;
            session.started_at = None;
            session.last_typing_at = None;
        }

        *stats = TypingStatsToday {
            date: today,
            typed_characters: 0,
            typing_seconds: 0,
            updated_at: now,
        };
        if let Ok(mut dirty) = self.dirty.lock() {
            *dirty = false;
        }
        if let Ok(mut last_flush_at) = self.last_flush_at.lock() {
            *last_flush_at = now;
        }
        persist_typing_stats(app, &stats)
    }
}

fn is_sensing_paused(app: &AppHandle) -> bool {
    app.state::<crate::app_awareness::ForegroundAppState>()
        .sensing_paused
        .lock()
        .map(|paused| *paused)
        .unwrap_or(false)
}

fn typing_stats_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("typing-stats.json"))
}

fn load_typing_stats(app: &AppHandle) -> Option<TypingStatsToday> {
    let path = typing_stats_path(app)?;
    let json = fs::read_to_string(path).ok()?;
    serde_json::from_str(&json).ok()
}

fn persist_typing_stats(app: &AppHandle, stats: &TypingStatsToday) -> Result<(), String> {
    let path = typing_stats_path(app).ok_or_else(|| "无法获取输入统计路径".to_string())?;
    let directory = path
        .parent()
        .ok_or_else(|| "无法获取输入统计目录".to_string())?;
    let json = serde_json::to_string(stats).map_err(|error| error.to_string())?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    fs::write(path, json).map_err(|error| error.to_string())
}

fn default_typing_stats_today() -> TypingStatsToday {
    let now = crate::unix_timestamp();
    TypingStatsToday {
        date: current_day_key(now),
        typed_characters: 0,
        typing_seconds: 0,
        updated_at: now,
    }
}

fn current_day_key(now: u64) -> String {
    chrono::Local
        .timestamp_opt(now as i64, 0)
        .single()
        .unwrap_or_else(chrono::Local::now)
        .format("%Y-%m-%d")
        .to_string()
}

#[cfg(not(target_os = "macos"))]
fn keypress_delta(key: Key) -> i64 {
    match key {
        Key::Backspace | Key::Delete | Key::KpDelete => -1,
        Key::Space | Key::Tab | Key::Return | Key::KpReturn => 1,
        Key::BackQuote
        | Key::Minus
        | Key::Equal
        | Key::LeftBracket
        | Key::RightBracket
        | Key::BackSlash
        | Key::IntlBackslash
        | Key::SemiColon
        | Key::Quote
        | Key::Comma
        | Key::Dot
        | Key::Slash
        | Key::Num0
        | Key::Num1
        | Key::Num2
        | Key::Num3
        | Key::Num4
        | Key::Num5
        | Key::Num6
        | Key::Num7
        | Key::Num8
        | Key::Num9
        | Key::Kp0
        | Key::Kp1
        | Key::Kp2
        | Key::Kp3
        | Key::Kp4
        | Key::Kp5
        | Key::Kp6
        | Key::Kp7
        | Key::Kp8
        | Key::Kp9
        | Key::KpPlus
        | Key::KpMinus
        | Key::KpMultiply
        | Key::KpDivide
        | Key::KeyA
        | Key::KeyB
        | Key::KeyC
        | Key::KeyD
        | Key::KeyE
        | Key::KeyF
        | Key::KeyG
        | Key::KeyH
        | Key::KeyI
        | Key::KeyJ
        | Key::KeyK
        | Key::KeyL
        | Key::KeyM
        | Key::KeyN
        | Key::KeyO
        | Key::KeyP
        | Key::KeyQ
        | Key::KeyR
        | Key::KeyS
        | Key::KeyT
        | Key::KeyU
        | Key::KeyV
        | Key::KeyW
        | Key::KeyX
        | Key::KeyY
        | Key::KeyZ => 1,
        _ => 0,
    }
}

#[cfg(target_os = "macos")]
fn macos_keycode_delta(keycode: i64) -> i64 {
    match keycode {
        // Delete/backspace.
        51 => -1,
        // Space, tab, return.
        49 | 48 | 36 => 1,
        // Main keyboard punctuation, number row, and letter keys.
        0..=9 | 11..=35 | 37..=47 | 50 => 1,
        // Keypad number and operator keys.
        65 | 67 | 69 | 75 | 78 | 81 | 82..=92 => 1,
        _ => 0,
    }
}

#[cfg(target_os = "macos")]
mod macos_keyboard_monitor {
    use super::{macos_keycode_delta, TypingActivityState};
    use core_graphics::event::{CGEvent, CGEventTapLocation, CGEventType, EventField};
    use std::{os::raw::c_void, ptr};
    use tauri::{AppHandle, Manager};

    type CFMachPortRef = *const c_void;
    type CFRunLoopRef = *const c_void;
    type CFRunLoopSourceRef = *const c_void;
    type CFRunLoopMode = *const c_void;
    type CGEventTapProxy = *const c_void;
    type CGEventRef = CGEvent;
    type CGEventMask = u64;
    type CGEventTapPlacement = u32;
    type CFAllocatorRef = *const c_void;
    type CFIndex = isize;

    const K_CG_HEAD_INSERT_EVENT_TAP: CGEventTapPlacement = 0;
    const K_CG_EVENT_TAP_OPTION_LISTEN_ONLY: u32 = 1;
    const KEY_DOWN_EVENT_MASK: CGEventMask = 1 << (CGEventType::KeyDown as u64);

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventTapCreate(
            tap: CGEventTapLocation,
            place: CGEventTapPlacement,
            options: u32,
            events_of_interest: CGEventMask,
            callback: EventTapCallback,
            user_info: *mut c_void,
        ) -> CFMachPortRef;
        fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFMachPortCreateRunLoopSource(
            allocator: CFAllocatorRef,
            port: CFMachPortRef,
            order: CFIndex,
        ) -> CFRunLoopSourceRef;
        fn CFRunLoopAddSource(rl: CFRunLoopRef, source: CFRunLoopSourceRef, mode: CFRunLoopMode);
        fn CFRunLoopGetCurrent() -> CFRunLoopRef;
        fn CFRunLoopRun();

        static kCFRunLoopCommonModes: CFRunLoopMode;
    }

    type EventTapCallback = unsafe extern "C" fn(
        proxy: CGEventTapProxy,
        event_type: CGEventType,
        event: CGEventRef,
        user_info: *mut c_void,
    ) -> CGEventRef;

    unsafe extern "C" fn event_tap_callback(
        _proxy: CGEventTapProxy,
        event_type: CGEventType,
        event: CGEventRef,
        user_info: *mut c_void,
    ) -> CGEventRef {
        if !matches!(event_type, CGEventType::KeyDown) || user_info.is_null() {
            return event;
        }

        let keycode = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
        let delta = macos_keycode_delta(keycode);
        if delta != 0 {
            let app = &*(user_info as *const AppHandle);
            let state = app.state::<TypingActivityState>();
            let _ = state.record_keypress(app, delta);
        }
        event
    }

    pub fn run(app: AppHandle) -> Result<(), &'static str> {
        let app = Box::new(app);
        let app_ptr = Box::into_raw(app) as *mut c_void;

        unsafe {
            let tap = CGEventTapCreate(
                CGEventTapLocation::HID,
                K_CG_HEAD_INSERT_EVENT_TAP,
                K_CG_EVENT_TAP_OPTION_LISTEN_ONLY,
                KEY_DOWN_EVENT_MASK,
                event_tap_callback,
                app_ptr,
            );
            if tap.is_null() {
                let _ = Box::from_raw(app_ptr as *mut AppHandle);
                return Err("event tap unavailable");
            }

            let run_loop_source = CFMachPortCreateRunLoopSource(ptr::null(), tap, 0);
            if run_loop_source.is_null() {
                let _ = Box::from_raw(app_ptr as *mut AppHandle);
                return Err("event tap run loop source unavailable");
            }

            CFRunLoopAddSource(
                CFRunLoopGetCurrent(),
                run_loop_source,
                kCFRunLoopCommonModes,
            );
            CGEventTapEnable(tap, true);
            CFRunLoopRun();
        }

        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub fn start_keyboard_monitor(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        if let Err(error) = macos_keyboard_monitor::run(app) {
            eprintln!("typing monitor stopped: {error}");
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn start_keyboard_monitor(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        let listen_result = listen(move |event: Event| {
            if let EventType::KeyPress(key) = event.event_type {
                let delta = keypress_delta(key);
                if delta == 0 {
                    return;
                }
                let state = app.state::<TypingActivityState>();
                let _ = state.record_keypress(&app, delta);
            }
        });
        if let Err(error) = listen_result {
            eprintln!("typing monitor stopped: {error:?}");
        }
    });
}

pub fn watch_typing_rollover(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || loop {
        let state = app.state::<TypingActivityState>();
        let now = crate::unix_timestamp();
        let _ = state.finalize_stale_session(&app, now);
        let _ = state.flush_snapshot_if_needed(&app, now);
        thread::sleep(Duration::from_secs(2));
    });
}

pub fn get_typing_stats_today(app: &AppHandle) -> Result<TypingStatsToday, String> {
    let state = app.state::<TypingActivityState>();
    state.snapshot(crate::unix_timestamp())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::macos_keycode_delta;

    #[test]
    fn macos_keycode_delta_counts_text_keys_without_layout_lookup() {
        assert_eq!(macos_keycode_delta(0), 1); // A
        assert_eq!(macos_keycode_delta(18), 1); // 1
        assert_eq!(macos_keycode_delta(49), 1); // Space
        assert_eq!(macos_keycode_delta(82), 1); // Keypad 0
        assert_eq!(macos_keycode_delta(51), -1); // Delete/backspace
        assert_eq!(macos_keycode_delta(123), 0); // Left arrow
        assert_eq!(macos_keycode_delta(56), 0); // Shift
    }
}
