use crate::storage;
/// System calendar bidirectional sync module.
///
/// The local calendar store remains the source of truth. On macOS we mirror
/// synced events into Calendar.app and pull back events that carry the Piko
/// sync marker. Other platforms keep the file-based iCalendar fallback path.
///
/// On macOS we use a native EventKit bridge (compiled from calendar_bridge.m)
/// linked directly into the binary. This avoids the osascript / AppleEvents
/// path which requires a separate TCC permission that is easy to deny.
use crate::CalendarEvent;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashSet,
    ffi::{CStr, CString},
    fs,
    os::raw::c_char,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

static CALENDAR_SYNC_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

const SYNC_MARKER_PREFIX: &str = "PIKO_SYNC local_id=";
const IMPORTED_SYSTEM_ID_PREFIX: &str = "system-macos-";

// ── EventKit bridge (calendar_bridge.m) ──────────────────────────────
#[cfg(target_os = "macos")]
extern "C" {
    /// Returns a static C string: "authorized", "denied", "restricted", "notDetermined".
    fn piko_calendar_auth_status() -> *const c_char;
    /// Requests calendar access (shows permission dialog). Blocks until user responds.
    /// Returns a heap-allocated string: "authorized" or "denied". Caller must free().
    fn piko_calendar_request_access() -> *mut c_char;
    /// Returns a heap-allocated JSON string. Caller must free() it.
    fn piko_calendar_pull() -> *mut c_char;
    /// Push events. Input is a JSON string. Returns a heap-allocated JSON string.
    fn piko_calendar_push(json: *const c_char) -> *mut c_char;
}

/// Mapping between local and system calendar event IDs.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSyncMapping {
    pub local_id: String,
    pub system_id: String,
    pub platform: String,
    pub last_synced_at: u64,
    pub local_modified_at: u64,
    pub system_modified_at: u64,
}

/// Conflict resolution result.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictResolution {
    KeepLocal,
    KeepSystem,
    PromptUser,
}

/// Determine conflict resolution based on modification timestamps.
pub fn resolve_conflict(
    local_modified_at: u64,
    system_modified_at: u64,
    last_synced_at: u64,
) -> ConflictResolution {
    if local_modified_at > last_synced_at && local_modified_at >= system_modified_at {
        return ConflictResolution::KeepLocal;
    }
    if system_modified_at > last_synced_at && local_modified_at <= last_synced_at {
        return ConflictResolution::KeepSystem;
    }
    ConflictResolution::PromptUser
}

/// Sync status for reporting to the UI.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub platform: String,
    pub available: bool,
    pub last_sync: Option<u64>,
    pub mapping_count: usize,
}

/// Result for a push sync.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PushResult {
    pub pushed: usize,
    pub mappings: Vec<CalendarSyncMapping>,
}

/// Result for a pull sync.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PullResult {
    pub imported: usize,
    pub events: Vec<CalendarEvent>,
}

/// Platform identifier.
pub fn current_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

/// Check if system calendar sync is available on this platform.
/// Returns true if the platform supports sync AND calendar access is either
/// already authorized or can still be requested (notDetermined).
pub fn is_sync_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        let status = bridge_auth_status();
        // "authorized" = already has permission
        // "notDetermined" = can still request permission (will show dialog on sync)
        status == "authorized" || status == "notDetermined"
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Call the ObjC bridge to get the calendar authorization status string.
#[cfg(target_os = "macos")]
fn bridge_auth_status() -> String {
    unsafe {
        let ptr = piko_calendar_auth_status();
        if ptr.is_null() {
            return "notDetermined".to_string();
        }
        CStr::from_ptr(ptr).to_string_lossy().into_owned()
    }
}

/// Read sync mappings from file.
pub fn read_sync_mappings(app: &tauri::AppHandle) -> Vec<CalendarSyncMapping> {
    sync_mapping_path(app)
        .map(|path| storage::read_or_default(&path))
        .unwrap_or_default()
}

/// Persist sync mappings to file.
pub fn persist_sync_mappings(
    app: &tauri::AppHandle,
    mappings: &[CalendarSyncMapping],
) -> Result<(), String> {
    let _transaction = storage::transaction();
    let path = sync_mapping_path(app).ok_or_else(|| "无法获取同步映射路径".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "无法获取同步映射目录".to_string())?;
    let json = serde_json::to_string_pretty(mappings).map_err(|e| e.to_string())?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    storage::write(
        &path,
        &serde_json::from_str::<serde_json::Value>(&json).map_err(|e| e.to_string())?,
    )
}

fn sync_mapping_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("calendar-sync-mapping.json"))
}

fn deleted_local_ids_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("calendar-sync-deleted-local-ids.json"))
}

fn read_deleted_local_ids(app: &tauri::AppHandle) -> HashSet<String> {
    deleted_local_ids_path(app)
        .map(|path| storage::read_or_default(&path))
        .unwrap_or_default()
}

/// Remove IDs from the deleted-local-ids list when they've been re-imported
/// from the system calendar. This prevents stale deletion records from
/// permanently blocking events that still exist in the system calendar.
fn cleanup_deleted_ids(app: &tauri::AppHandle, reimported_ids: &HashSet<String>) {
    let _transaction = storage::transaction();
    let path = match deleted_local_ids_path(app) {
        Some(p) => p,
        None => return,
    };
    let mut deleted_ids = read_deleted_local_ids(app);
    let before = deleted_ids.len();
    deleted_ids.retain(|id| !reimported_ids.contains(id));
    if deleted_ids.len() != before {
        if let Err(error) = storage::write(&path, &deleted_ids) {
            eprintln!("[storage] {error}");
        }
    }
}

pub(crate) fn mark_local_events_deleted(
    app: &tauri::AppHandle,
    local_ids: &[String],
) -> Result<(), String> {
    let _transaction = storage::transaction();
    let path = deleted_local_ids_path(app).ok_or_else(|| "无法获取日程删除记录路径".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "无法获取日程删除记录目录".to_string())?;
    let mut deleted_ids = read_deleted_local_ids(app);
    deleted_ids.extend(local_ids.iter().cloned());
    let json = serde_json::to_string_pretty(&deleted_ids).map_err(|e| e.to_string())?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    storage::write(
        &path,
        &serde_json::from_str::<serde_json::Value>(&json).map_err(|e| e.to_string())?,
    )
}

fn sync_marker(local_id: &str) -> String {
    format!("{SYNC_MARKER_PREFIX}{local_id}")
}

fn local_id_for_system_event(system_id: &str) -> String {
    let mut escaped = String::new();
    for byte in system_id.as_bytes() {
        match *byte {
            b'0'..=b'9' | b'a'..=b'z' | b'A'..=b'Z' | b'-' | b'_' => escaped.push(*byte as char),
            _ => escaped.push_str(&format!("{byte:02x}")),
        }
    }
    format!("{IMPORTED_SYSTEM_ID_PREFIX}{escaped}")
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn description_for_event(event: &CalendarEvent, local_id: &str) -> String {
    let marker = sync_marker(local_id);
    match event
        .notes
        .as_deref()
        .map(str::trim)
        .filter(|notes| !notes.is_empty())
    {
        Some(notes) => format!("{notes}\n{marker}"),
        None => marker,
    }
}

/// Push events to system calendar via the EventKit bridge.
#[cfg(target_os = "macos")]
fn bridge_push(payload: &serde_json::Value) -> Result<serde_json::Value, String> {
    let json_str = serde_json::to_string(payload).map_err(|e| e.to_string())?;
    let input = CString::new(json_str).map_err(|e| e.to_string())?;
    decode_bridge_pointer(unsafe { piko_calendar_push(input.as_ptr()) })
}

/// Pull events from system calendar via the EventKit bridge.
#[cfg(target_os = "macos")]
fn bridge_pull() -> Result<serde_json::Value, String> {
    decode_bridge_pointer(unsafe { piko_calendar_pull() })
}

#[cfg(target_os = "macos")]
fn decode_bridge_pointer(raw: *mut c_char) -> Result<serde_json::Value, String> {
    if raw.is_null() {
        return Err("系统日历未返回有效数据，请重试".to_string());
    }
    // The bridge owns this allocation until returning it; release it after copying.
    let text = unsafe {
        let text = CStr::from_ptr(raw).to_string_lossy().into_owned();
        extern "C" {
            fn free(ptr: *mut std::ffi::c_void);
        }
        free(raw as *mut _);
        text
    };
    decode_bridge_response(&text)
}

#[cfg(any(target_os = "macos", test))]
fn decode_bridge_response(raw: &str) -> Result<serde_json::Value, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| "系统日历返回的数据无效，请重试".to_string())?;
    if let Some(error) = value.get("error").and_then(serde_json::Value::as_str) {
        return Err(format!("系统日历同步失败：{error}"));
    }
    if !value.is_array() {
        return Err("系统日历返回的数据格式无效".to_string());
    }
    Ok(value)
}

fn log_debug(msg: &str) {
    let path = std::env::temp_dir().join("piko_calendar_debug.log");
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let line = format!("[{timestamp}] {msg}\n");
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
}

/// Ensure we have calendar access. If not yet determined, requests access
/// (shows macOS permission dialog). Returns an error if access is denied.
#[cfg(target_os = "macos")]
fn ensure_calendar_access() -> Result<(), String> {
    let status = bridge_auth_status();
    match status.as_str() {
        "authorized" => Ok(()),
        "unavailable" => Err("系统日历暂时不可用，请稍后重试".to_string()),
        "denied" | "restricted" => Err(
            "日历权限被拒绝。请在 系统设置 → 隐私与安全 → 日历 中允许 Piko 访问日历。".to_string(),
        ),
        _ => {
            // notDetermined — request access (shows permission dialog)
            unsafe {
                let raw = piko_calendar_request_access();
                if raw.is_null() {
                    return Err("请求日历权限失败".to_string());
                }
                let result = CStr::from_ptr(raw).to_string_lossy().into_owned();
                extern "C" {
                    fn free(ptr: *mut std::ffi::c_void);
                }
                free(raw as *mut _);
                if result == "authorized" {
                    Ok(())
                } else if result == "missingUsageDescription" {
                    Err("应用缺少日历权限声明，请安装修复后的 Piko 版本再导入日程".to_string())
                } else if result == "exception" {
                    Err("系统日历授权发生异常，请稍后重试".to_string())
                } else if result == "timeout" {
                    Err("请求日历权限超时".to_string())
                } else {
                    Err(
                        "日历权限被拒绝。请在 系统设置 → 隐私与安全 → 日历 中允许 Piko 访问日历。"
                            .to_string(),
                    )
                }
            }
        }
    }
}

/// Push local events into the system calendar.
pub(crate) fn push_to_system_calendar(
    app: &AppHandle,
    events: &[CalendarEvent],
) -> Result<PushResult, String> {
    let _sync = CALENDAR_SYNC_LOCK
        .lock()
        .map_err(|_| "日历同步发生异常，请重启应用后重试".to_string())?;
    if !cfg!(target_os = "macos") {
        return Err("当前平台尚未开放系统日历同步".to_string());
    }
    ensure_calendar_access()?;
    let _transaction = storage::transaction();

    let mut mappings = read_sync_mappings(app);
    let platform = current_platform().to_string();
    let mut by_local_id = mappings
        .iter()
        .map(|mapping| (mapping.local_id.clone(), mapping.clone()))
        .collect::<std::collections::HashMap<_, _>>();

    let mut payload_events = Vec::with_capacity(events.len());
    for event in events {
        let local_id = event.id.clone();
        let mapping = by_local_id.get(&local_id).cloned();
        payload_events.push(json!({
            "localId": local_id,
            "systemId": mapping.as_ref().map(|m| m.system_id.clone()),
            "title": event.title,
            "startAt": event.start_at,
            "endAt": event.end_at,
            "location": event.location,
            "description": description_for_event(event, &event.id),
            "localModifiedAt": now_unix(),
        }));
    }

    #[cfg(target_os = "macos")]
    let output = bridge_push(&json!({
        "events": payload_events,
    }))?;

    #[cfg(not(target_os = "macos"))]
    let output = serde_json::Value::Array(vec![]);

    let created = output
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| {
            let local_id = entry["localId"].as_str()?.to_string();
            let system_id = entry["systemId"].as_str()?.to_string();
            let local_modified_at = entry["localModifiedAt"].as_u64().unwrap_or_default();
            Some(CalendarSyncMapping {
                local_id,
                system_id,
                platform: platform.clone(),
                last_synced_at: now_unix(),
                local_modified_at,
                system_modified_at: now_unix(),
            })
        })
        .collect::<Vec<_>>();

    for mapping in created {
        if let Some(existing) = by_local_id.get_mut(&mapping.local_id) {
            *existing = mapping.clone();
        } else {
            mappings.push(mapping);
        }
    }

    mappings.sort_by(|a, b| a.local_id.cmp(&b.local_id));
    persist_sync_mappings(app, &mappings)?;

    Ok(PushResult {
        pushed: payload_events.len(),
        mappings,
    })
}

/// Pull events from the system calendar back into local form.
pub(crate) fn pull_from_system_calendar(app: &AppHandle, since: u64) -> Result<PullResult, String> {
    let _sync = CALENDAR_SYNC_LOCK
        .lock()
        .map_err(|_| "日历同步发生异常，请重启应用后重试".to_string())?;
    if !cfg!(target_os = "macos") {
        return Err("当前平台尚未开放系统日历同步".to_string());
    }
    log_debug("pull: start");
    ensure_calendar_access()?;

    // Pull all events from the system calendar.
    // We do NOT filter by deleted_local_ids here — the system calendar is the
    // source of truth. If a user deleted an event locally but it still exists
    // in the system calendar, re-importing it is the correct behavior.
    let system_events = read_system_events(since)?;
    log_debug(&format!("pull: {} events from bridge", system_events.len()));

    if system_events.is_empty() {
        log_debug("pull: no events, returning early");
        return Ok(PullResult {
            imported: 0,
            events: vec![],
        });
    }

    let events: Vec<CalendarEvent> = system_events
        .iter()
        .map(SystemCalendarEvent::to_calendar_event)
        .collect();

    let _transaction = storage::transaction();
    let mut local_events = crate::read_calendar_events(app);
    log_debug(&format!(
        "pull: {} existing local events",
        local_events.len()
    ));
    let mut known_ids = local_events
        .iter()
        .map(|event| event.id.clone())
        .collect::<std::collections::HashSet<_>>();

    let mut imported = 0usize;
    for event in &events {
        if let Some(existing) = local_events.iter_mut().find(|item| item.id == event.id) {
            *existing = event.clone();
        } else if known_ids.insert(event.id.clone()) {
            local_events.push(event.clone());
            imported += 1;
        }
    }

    update_mappings_from_system_events(app, &system_events)?;

    // Remove any deleted-local-ids entries that correspond to events we just
    // re-imported, so the push side doesn't try to delete them from the system.
    let reimported_ids: HashSet<String> = events.iter().map(|e| e.id.clone()).collect();
    cleanup_deleted_ids(app, &reimported_ids);

    local_events.sort_by_key(|a| a.start_at);
    crate::persist_calendar_events(app, &local_events)?;
    log_debug(&format!(
        "pull: DONE imported={}, total={}",
        imported,
        local_events.len()
    ));

    Ok(PullResult {
        imported,
        events: local_events,
    })
}

#[cfg(test)]
fn exclude_deleted_local_events(events: &mut Vec<CalendarEvent>, deleted_ids: &HashSet<String>) {
    events.retain(|event| !deleted_ids.contains(&event.id));
}

fn update_mappings_from_system_events(
    app: &AppHandle,
    system_events: &[SystemCalendarEvent],
) -> Result<(), String> {
    let _transaction = storage::transaction();
    let mut mappings = read_sync_mappings(app);
    let now = now_unix();

    for event in system_events {
        let local_id = event.resolved_local_id();
        if let Some(mapping) = mappings
            .iter_mut()
            .find(|mapping| mapping.local_id == local_id)
        {
            mapping.system_id = event.system_id.clone();
            mapping.platform = event.platform.clone();
            mapping.last_synced_at = now;
            mapping.system_modified_at = event.system_modified_at;
        } else {
            mappings.push(CalendarSyncMapping {
                local_id,
                system_id: event.system_id.clone(),
                platform: event.platform.clone(),
                last_synced_at: now,
                local_modified_at: now,
                system_modified_at: event.system_modified_at,
            });
        }
    }

    mappings.sort_by(|a, b| a.local_id.cmp(&b.local_id));
    persist_sync_mappings(app, &mappings)
}

fn read_system_events(_since: u64) -> Result<Vec<SystemCalendarEvent>, String> {
    if !cfg!(target_os = "macos") {
        return Err("当前平台尚未开放系统日历同步".to_string());
    }

    #[cfg(target_os = "macos")]
    let output = bridge_pull()?;

    #[cfg(not(target_os = "macos"))]
    let output = json!([]);

    let arr = output.as_array().cloned().unwrap_or_default();
    log_debug(&format!(
        "read_system_events: {} items from bridge",
        arr.len()
    ));

    let mut system_events = Vec::new();
    for (i, entry) in arr.iter().enumerate() {
        match serde_json::from_value::<SystemCalendarEvent>(entry.clone()) {
            Ok(ev) => {
                system_events.push(ev);
            }
            Err(_) => log_debug(&format!("read_system_events: [{i}] invalid event")),
        }
    }

    Ok(system_events)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SystemCalendarEvent {
    local_id: String,
    system_id: String,
    title: String,
    start_at: u64,
    end_at: u64,
    location: Option<String>,
    notes: Option<String>,
    system_modified_at: u64,
    platform: String,
}

impl SystemCalendarEvent {
    fn resolved_local_id(&self) -> String {
        if self.local_id.trim().is_empty() {
            local_id_for_system_event(&self.system_id)
        } else {
            self.local_id.clone()
        }
    }

    fn to_calendar_event(&self) -> CalendarEvent {
        CalendarEvent {
            id: self.resolved_local_id(),
            title: self.title.clone(),
            start_at: self.start_at,
            end_at: self.end_at,
            location: self.location.clone(),
            notes: self.notes.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        decode_bridge_response, exclude_deleted_local_events, local_id_for_system_event,
        SystemCalendarEvent,
    };
    use crate::CalendarEvent;
    use std::collections::HashSet;

    #[test]
    fn imports_long_unicode_payload_without_slicing_inside_a_character() {
        let title = format!("a{}🙂", "中".repeat(600));
        let payload = serde_json::to_string(&serde_json::json!([{"title":title}])).unwrap();
        assert!(
            !payload.is_char_boundary(500),
            "Fixture must reproduce the old byte-slice panic"
        );
        let decoded = decode_bridge_response(&payload).unwrap();
        assert_eq!(decoded[0]["title"], title);
    }

    #[test]
    fn native_errors_and_invalid_responses_do_not_become_empty_successful_imports() {
        assert_eq!(decode_bridge_response("[]").unwrap(), serde_json::json!([]));
        assert!(decode_bridge_response(r#"{"error":"EventKit exception"}"#)
            .unwrap_err()
            .contains("EventKit exception"));
        for invalid in ["", "null", "{}", "broken", r#"{"events":[]}"#] {
            assert!(decode_bridge_response(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn excludes_locally_deleted_events_when_pulling_from_system_calendar() {
        let mut events = vec![
            CalendarEvent {
                id: "deleted".to_string(),
                title: "已删除".to_string(),
                start_at: 100,
                end_at: 200,
                location: None,
                notes: None,
            },
            CalendarEvent {
                id: "active".to_string(),
                title: "保留".to_string(),
                start_at: 300,
                end_at: 400,
                location: None,
                notes: None,
            },
        ];

        exclude_deleted_local_events(&mut events, &HashSet::from(["deleted".to_string()]));

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "active");
    }

    #[test]
    fn creates_stable_local_ids_for_unmarked_system_events() {
        assert_eq!(
            local_id_for_system_event("ABC/123"),
            "system-macos-ABC2f123"
        );
    }

    #[test]
    fn converts_unmarked_system_events_to_local_calendar_events() {
        let event = SystemCalendarEvent {
            local_id: "".to_string(),
            system_id: "system-id".to_string(),
            title: "系统会议".to_string(),
            start_at: 100,
            end_at: 200,
            location: Some("会议室".to_string()),
            notes: Some("来自系统日历".to_string()),
            system_modified_at: 300,
            platform: "macos".to_string(),
        };

        let local = event.to_calendar_event();

        assert_eq!(local.id, "system-macos-system-id");
        assert_eq!(local.title, "系统会议");
        assert_eq!(local.location.as_deref(), Some("会议室"));
        assert_eq!(local.notes.as_deref(), Some("来自系统日历"));
    }
}
