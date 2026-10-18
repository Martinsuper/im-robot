//! S07 activity awareness and quiet gating. Every suppression is fail-closed:
//! unknown lock/idle/visibility states postpone delivery instead of guessing;
//! resumption only treats new events as active after a stable grace period.
use super::model::ActivitySnapshot;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const HEARTBEAT_STALE: Duration = Duration::from_secs(10);
pub const OBSERVED_AT_TOLERANCE: i64 = 5;
pub const STABLE_ACTIVE: Duration = Duration::from_secs(30);

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum GateDecision {
    Proceed,
    Blocked(&'static str),
}

struct Inner {
    reported: Option<(ActivitySnapshot, Instant)>,
    last_suppressed: Option<Instant>,
    sources: HashMap<String, (ActivitySnapshot, Instant)>,
    idle_return: IdleReturn,
}

/// UI heartbeat state, interrogated by the dispatcher and never trusted for
/// backend-owned signals (agent busy/awaiting remain backend-only).
pub struct ActivityState {
    inner: Mutex<Inner>,
}

impl Default for ActivityState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                reported: None,
                last_suppressed: None,
                sources: HashMap::new(),
                idle_return: IdleReturn::default(),
            }),
        }
    }
}

impl ActivityState {
    pub fn returned_from_idle(&self, idle: Option<u64>, locked: Option<bool>) -> bool {
        self.inner.lock().map(|mut inner| inner.idle_return.observe(idle, locked)).unwrap_or(false)
    }

    /// Accept a heartbeat; a claimed future observation is rejected outright.
    pub fn report(&self, snapshot: ActivitySnapshot, wall_now: i64) -> Result<(), &'static str> {
        self.report_from("test", snapshot, wall_now)
    }
    pub fn report_from(
        &self,
        source: &str,
        snapshot: ActivitySnapshot,
        wall_now: i64,
    ) -> Result<(), &'static str> {
        if snapshot.observed_at > wall_now + OBSERVED_AT_TOLERANCE {
            return Err("activity_observed_in_future");
        }
        let mut inner = self.inner.lock().map_err(|_| "state_unavailable")?;
        let now = Instant::now();
        inner.sources.insert(source.into(), (snapshot.clone(), now));
        inner.reported = Some((snapshot, now));
        Ok(())
    }
    pub fn read(&self) -> Option<(ActivitySnapshot, Duration)> {
        let inner = self.inner.lock().ok()?;
        let (snapshot, received) = inner.reported.as_ref()?;
        let mut snapshot = snapshot.clone();
        let fresh: Vec<_> = inner
            .sources
            .values()
            .filter(|(_, at)| at.elapsed() <= HEARTBEAT_STALE)
            .collect();
        snapshot.typing = if fresh.iter().any(|(sample, _)| sample.typing == Some(true)) {
            Some(true)
        } else if fresh.iter().any(|(sample, _)| sample.typing == Some(false)) {
            Some(false)
        } else {
            None
        };
        Some((snapshot, received.elapsed()))
    }
    pub fn source_fresh(&self, source: &str) -> bool {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| {
                inner
                    .sources
                    .get(source)
                    .map(|(_, at)| at.elapsed() <= HEARTBEAT_STALE)
            })
            .unwrap_or(false)
    }
    pub fn age_since_last_suppression(&self) -> Option<Duration> {
        self.inner
            .lock()
            .ok()?
            .last_suppressed
            .map(|at| at.elapsed())
    }

    /// Suppressing a dispatch attempt restarts the stable-active grace window.
    pub fn mark_suppressed(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.last_suppressed = Some(Instant::now());
        }
    }
}

/// All inputs the gate needs; every source stays optional so the decision can
/// be conservative without crashing on partial telemetry.
#[derive(Debug, Default, Clone)]
pub struct GateInputs {
    pub quiet_mode: Option<String>,
    /// True while inside the persisted quiet hours window (shared config).
    pub quiet_hours_active: bool,
    pub idle_seconds: Option<u64>,
    pub idle_threshold: Option<u64>,
    pub agent_busy: Option<bool>,
    pub awaiting_confirmation: Option<bool>,
    /// Latest accepted heartbeat plus its receive age.
    pub heartbeat: Option<(ActivitySnapshot, Duration)>,
}

/// Gate order per contract: quiet mode → quiet hours → lock/idle/typing →
/// backend agent state → pet visibility → stable-active grace.
pub fn decide(inputs: &GateInputs, last_suppressed: Option<Duration>) -> GateDecision {
    if inputs.quiet_mode.as_deref() == Some("minimal") {
        return GateDecision::Blocked("quiet_mode_minimal");
    }
    if inputs.quiet_hours_active {
        return GateDecision::Blocked("quiet_hours");
    }
    let Some((snapshot, age)) = inputs.heartbeat.as_ref() else {
        return GateDecision::Blocked("heartbeat_missing");
    };
    if age > &HEARTBEAT_STALE {
        return GateDecision::Blocked("heartbeat_stale");
    }
    match snapshot.locked {
        Some(true) => return GateDecision::Blocked("locked"),
        None => return GateDecision::Blocked("lock_unknown"),
        Some(false) => {}
    }
    match (inputs.idle_seconds, inputs.idle_threshold) {
        (Some(idle), Some(threshold)) if idle >= threshold => {
            return GateDecision::Blocked("user_idle")
        }
        (None, _) => return GateDecision::Blocked("idle_unknown"),
        (Some(_), None) => return GateDecision::Blocked("idle_threshold_unknown"),
        _ => {}
    }
    if snapshot.typing == Some(true) {
        return GateDecision::Blocked("user_typing");
    }
    if inputs.agent_busy.is_none() || inputs.awaiting_confirmation.is_none() {
        return GateDecision::Blocked("agent_state_unknown");
    }
    if snapshot.typing.is_none() {
        return GateDecision::Blocked("typing_unknown");
    }
    if inputs.agent_busy == Some(true) {
        return GateDecision::Blocked("agent_busy");
    }
    if inputs.awaiting_confirmation == Some(true) {
        return GateDecision::Blocked("awaiting_confirmation");
    }
    match snapshot.pet_visible {
        Some(true) => {}
        Some(false) => return GateDecision::Blocked("pet_hidden"),
        None => return GateDecision::Blocked("pet_unknown"),
    }
    // Any suppression inside the last stable window postpones again.
    if let Some(since) = last_suppressed {
        if since < STABLE_ACTIVE {
            return GateDecision::Blocked("unstable_after_suppression");
        }
    }
    GateDecision::Proceed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(
        locked: Option<bool>,
        idle_flag: Option<bool>,
        typing: Option<bool>,
        pet: Option<bool>,
        agent: Option<bool>,
        awaiting: Option<bool>,
    ) -> ActivitySnapshot {
        ActivitySnapshot {
            observed_at: 1_000,
            locked,
            idle: idle_flag,
            typing,
            agent_busy: agent,
            awaiting_confirmation: awaiting,
            pet_visible: pet,
            quiet_mode: None,
        }
    }

    fn inputs(snapshot: ActivitySnapshot, age_ms: u64) -> GateInputs {
        GateInputs {
            // Backend-owned agent markers are carried into the gate inputs;
            // the OS idle sample is neutral (measured, below threshold) so the
            // idle stage does not shadow the state under test.
            agent_busy: snapshot.agent_busy,
            awaiting_confirmation: snapshot.awaiting_confirmation,
            idle_seconds: Some(0),
            idle_threshold: Some(u64::MAX / 2),
            heartbeat: Some((snapshot, Duration::from_millis(age_ms))),
            ..Default::default()
        }
    }

    #[test]
    fn healthy_active_state_proceeds() {
        let state = inputs(
            snapshot(
                Some(false),
                Some(false),
                Some(false),
                Some(true),
                Some(false),
                Some(false),
            ),
            1_000,
        );
        assert_eq!(
            decide(&state, Some(STABLE_ACTIVE + Duration::from_secs(1))),
            GateDecision::Proceed
        );
    }

    #[test]
    fn quiet_mode_and_hours_block_before_anything_else() {
        let mut minimal = inputs(
            snapshot(
                Some(false),
                Some(false),
                Some(false),
                Some(true),
                Some(false),
                Some(false),
            ),
            1_000,
        );
        minimal.quiet_mode = Some("minimal".into());
        assert_eq!(
            decide(&minimal, None),
            GateDecision::Blocked("quiet_mode_minimal")
        );
        let mut hours = inputs(
            snapshot(
                Some(false),
                Some(false),
                Some(false),
                Some(true),
                Some(false),
                Some(false),
            ),
            1_000,
        );
        hours.quiet_hours_active = true;
        assert_eq!(decide(&hours, None), GateDecision::Blocked("quiet_hours"));
    }

    #[test]
    fn stale_or_missing_heartbeats_are_conservative() {
        assert_eq!(
            decide(&GateInputs::default(), None),
            GateDecision::Blocked("heartbeat_missing")
        );
        let stale = inputs(
            snapshot(
                Some(false),
                Some(false),
                Some(false),
                Some(true),
                Some(false),
                Some(false),
            ),
            HEARTBEAT_STALE.as_millis() as u64 + 1,
        );
        assert_eq!(
            decide(&stale, None),
            GateDecision::Blocked("heartbeat_stale")
        );
    }

    #[test]
    fn every_unknown_relevant_state_blocks() {
        let locked_unknown = inputs(
            snapshot(
                None,
                Some(false),
                Some(false),
                Some(true),
                Some(false),
                Some(false),
            ),
            1_000,
        );
        assert_eq!(
            decide(&locked_unknown, None),
            GateDecision::Blocked("lock_unknown")
        );
        let mut no_idle_sample = inputs(
            snapshot(
                Some(false),
                Some(true),
                Some(false),
                Some(true),
                Some(false),
                Some(false),
            ),
            1_000,
        );
        no_idle_sample.idle_seconds = None;
        no_idle_sample.idle_threshold = None;
        assert_eq!(
            decide(&no_idle_sample, None),
            GateDecision::Blocked("idle_unknown")
        );
        let pet_unknown = inputs(
            snapshot(
                Some(false),
                Some(false),
                Some(false),
                None,
                Some(false),
                Some(false),
            ),
            1_000,
        );
        assert_eq!(
            decide(&pet_unknown, None),
            GateDecision::Blocked("pet_unknown")
        );
    }

    #[test]
    fn active_suppression_sources_block() {
        let cases = [
            (
                "locked",
                snapshot(
                    Some(true),
                    Some(false),
                    Some(false),
                    Some(true),
                    Some(false),
                    Some(false),
                ),
            ),
            (
                "user_typing",
                snapshot(
                    Some(false),
                    Some(false),
                    Some(true),
                    Some(true),
                    Some(false),
                    Some(false),
                ),
            ),
            (
                "agent_busy",
                snapshot(
                    Some(false),
                    Some(false),
                    Some(false),
                    Some(true),
                    Some(true),
                    Some(false),
                ),
            ),
            (
                "awaiting_confirmation",
                snapshot(
                    Some(false),
                    Some(false),
                    Some(false),
                    Some(true),
                    Some(false),
                    Some(true),
                ),
            ),
            (
                "pet_hidden",
                snapshot(
                    Some(false),
                    Some(false),
                    Some(false),
                    Some(false),
                    Some(false),
                    Some(false),
                ),
            ),
        ];
        for (expected, snapshot) in cases {
            let state = inputs(snapshot, 1_000);
            assert_eq!(decide(&state, None), GateDecision::Blocked(expected));
        }
        let mut idle_long = inputs(
            snapshot(
                Some(false),
                Some(true),
                Some(false),
                Some(true),
                Some(false),
                Some(false),
            ),
            1_000,
        );
        idle_long.idle_seconds = Some(120);
        idle_long.idle_threshold = Some(60);
        assert_eq!(decide(&idle_long, None), GateDecision::Blocked("user_idle"));
    }

    #[test]
    fn unstable_grace_blocks_recent_suppression() {
        let state = inputs(
            snapshot(
                Some(false),
                Some(false),
                Some(false),
                Some(true),
                Some(false),
                Some(false),
            ),
            1_000,
        );
        assert_eq!(
            decide(&state, Some(STABLE_ACTIVE - Duration::from_secs(1))),
            GateDecision::Blocked("unstable_after_suppression")
        );
        assert_eq!(
            decide(&state, Some(STABLE_ACTIVE + Duration::from_secs(1))),
            GateDecision::Proceed
        );
    }

    #[test]
    fn heartbeat_report_is_stored_and_future_rejected() {
        let state = ActivityState::default();
        let mut first = snapshot(
            Some(false),
            Some(false),
            Some(false),
            Some(true),
            Some(false),
            Some(false),
        );
        first.observed_at = 1_000;
        state.report(first.clone(), 1_000).unwrap();
        let mut within_tolerance = first.clone();
        within_tolerance.observed_at = 1_003;
        state.report(within_tolerance, 1_000).unwrap();
        let mut future = first.clone();
        future.observed_at = 1_100;
        assert_eq!(
            state.report(future, 1_000).unwrap_err(),
            "activity_observed_in_future"
        );
        let (_, age) = state.read().unwrap();
        assert!(age < Duration::from_secs(1));
    }

    #[test]
    fn suppression_marking_restarts_stable_window() {
        let state = ActivityState::default();
        state
            .report(
                snapshot(
                    Some(true),
                    Some(false),
                    Some(false),
                    Some(true),
                    Some(false),
                    Some(false),
                ),
                1_000,
            )
            .unwrap();
        state.mark_suppressed();
        let age = state.age_since_last_suppression().unwrap();
        assert!(age <= STABLE_ACTIVE);
    }
}

/// OS-owned lock state. Unknown platforms remain fail-closed.
#[cfg(target_os = "macos")]
pub fn system_locked() -> Option<bool> {
    use std::ffi::{c_char, c_void};
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn CGSessionCopyCurrentDictionary() -> *const c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            allocator: *const c_void,
            text: *const c_char,
            encoding: u32,
        ) -> *const c_void;
        fn CFDictionaryGetValue(dictionary: *const c_void, key: *const c_void) -> *const c_void;
        fn CFGetTypeID(value: *const c_void) -> usize;
        fn CFBooleanGetTypeID() -> usize;
        fn CFBooleanGetValue(value: *const c_void) -> bool;
        fn CFRelease(value: *const c_void);
    }
    unsafe {
        let dictionary = CGSessionCopyCurrentDictionary();
        if dictionary.is_null() {
            return None;
        }
        let boolean = |name: &std::ffi::CStr| -> Option<bool> {
            let key = CFStringCreateWithCString(std::ptr::null(), name.as_ptr(), 0x08000100);
            if key.is_null() {
                return None;
            }
            let value = CFDictionaryGetValue(dictionary, key);
            CFRelease(key);
            if value.is_null() || CFGetTypeID(value) != CFBooleanGetTypeID() {
                None
            } else {
                Some(CFBooleanGetValue(value))
            }
        };
        let on_console = boolean(c"kCGSSessionOnConsoleKey").or_else(||boolean(c"kCGSessionOnConsoleKey"));
        let logged_in = boolean(c"kCGSessionLoginDoneKey");
        let locked = boolean(c"CGSSessionScreenIsLocked");
        let result = match (on_console, logged_in, locked) {
            (_, _, Some(true)) | (Some(false), _, _) => Some(true),
            (Some(true), Some(true), locked) => Some(locked.unwrap_or(false)),
            _ => None,
        };
        CFRelease(dictionary);
        result
    }
}

#[cfg(target_os = "windows")]
pub fn system_locked() -> Option<bool> {
    use std::ffi::c_void;
    #[link(name = "user32")]
    extern "system" {
        fn OpenInputDesktop(flags: u32, inherit: i32, access: u32) -> *mut c_void;
        fn CloseDesktop(desktop: *mut c_void) -> i32;
    }
    unsafe {
        let desktop = OpenInputDesktop(0, 0, 1);
        if desktop.is_null() {
            Some(true)
        } else {
            CloseDesktop(desktop);
            Some(false)
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn system_locked() -> Option<bool> {
    None
}

#[cfg(target_os = "macos")]
pub fn keyboard_idle_seconds() -> Option<u64> {
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event: u32) -> f64;
    }
    let seconds = unsafe { CGEventSourceSecondsSinceLastEventType(1, 10) };
    if seconds.is_finite() && seconds >= 0.0 {
        Some(seconds as u64)
    } else {
        None
    }
}
#[cfg(target_os = "windows")]
pub fn keyboard_idle_seconds() -> Option<u64> {
    crate::ambient::system_idle_seconds()
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn keyboard_idle_seconds() -> Option<u64> {
    None
}

/// Return greetings require a measured absence; unknown samples never infer it.
#[derive(Default)]
struct IdleReturn { armed: bool }
impl IdleReturn {
    fn observe(&mut self, idle: Option<u64>, locked: Option<bool>) -> bool {
        match (idle, locked) {
            (Some(seconds), Some(false)) if seconds >= 30 * 60 => { self.armed = true; false }
            (Some(seconds), Some(false)) if seconds < 5 => std::mem::take(&mut self.armed),
            (Some(_), Some(true)) => false,
            (Some(_), Some(false)) => false,
            _ => { self.armed = false; false }
        }
    }
}
#[cfg(test)]
mod return_greeting_tests {
    use super::*;
    #[test]
    fn only_measured_long_absence_yields_one_return_event() {
        let mut state=IdleReturn::default();
        assert!(!state.observe(Some(0),Some(false)));
        assert!(!state.observe(Some(1800),Some(false)));
        assert!(!state.observe(Some(0),Some(true)));
        assert!(state.observe(Some(0),Some(false)));
        assert!(!state.observe(Some(0),Some(false)));
        state.observe(Some(1800),Some(false));
        state.observe(None,None);
        assert!(!state.observe(Some(0),Some(false)));
    }
}
