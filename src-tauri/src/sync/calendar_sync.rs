/// System calendar bidirectional sync module.
///
/// The local calendar store remains the source of truth. On macOS we mirror
/// synced events into Calendar.app and pull back events that carry the Piko
/// sync marker. Other platforms keep the file-based iCalendar fallback path.
use crate::CalendarEvent;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashSet,
    fs,
    path::PathBuf,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const SYNC_MARKER_PREFIX: &str = "PIKO_SYNC local_id=";
const DEFAULT_SYNC_CALENDAR_NAME: &str = "Piko";
const IMPORTED_SYSTEM_ID_PREFIX: &str = "system-macos-";

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
pub fn is_sync_available() -> bool {
    cfg!(target_os = "macos")
}

/// Read sync mappings from file.
pub fn read_sync_mappings(app: &tauri::AppHandle) -> Vec<CalendarSyncMapping> {
    sync_mapping_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

/// Persist sync mappings to file.
pub fn persist_sync_mappings(
    app: &tauri::AppHandle,
    mappings: &[CalendarSyncMapping],
) -> Result<(), String> {
    let path = sync_mapping_path(app).ok_or_else(|| "无法获取同步映射路径".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "无法获取同步映射目录".to_string())?;
    let json = serde_json::to_string_pretty(mappings).map_err(|e| e.to_string())?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
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
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

pub(crate) fn mark_local_events_deleted(
    app: &tauri::AppHandle,
    local_ids: &[String],
) -> Result<(), String> {
    let path = deleted_local_ids_path(app).ok_or_else(|| "无法获取日程删除记录路径".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "无法获取日程删除记录目录".to_string())?;
    let mut deleted_ids = read_deleted_local_ids(app);
    deleted_ids.extend(local_ids.iter().cloned());
    let json = serde_json::to_string_pretty(&deleted_ids).map_err(|e| e.to_string())?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn system_calendar_name() -> &'static str {
    DEFAULT_SYNC_CALENDAR_NAME
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

fn build_jxa_script(payload: &serde_json::Value) -> String {
    format!(
        r#"
const payload = {};
function hasText(value) {{
  return value !== null && value !== undefined && String(value).trim().length > 0;
}}
function toMillis(dateValue) {{
  const date = new Date(dateValue);
  return Math.floor(date.getTime() / 1000);
}}
function main() {{
  const Calendar = Application("Calendar");
  Calendar.includeStandardAdditions = true;
  const writableCalendars = Calendar.calendars.whose({{ writable: true }});
  if (!writableCalendars.length) {{
    throw new Error("没有可写的系统日历");
  }}
  const defaultCalendar = writableCalendars[0];
  const result = payload.events.map((item) => {{
    let event = null;
    if (item.systemId) {{
      try {{
        event = defaultCalendar.events.byId(item.systemId);
      }} catch (_) {{
        event = null;
      }}
    }}
    const eventSpec = {{
      summary: item.title,
      startDate: new Date(item.startAt * 1000),
      endDate: new Date(item.endAt * 1000),
    }};
    if (hasText(item.location)) {{
      eventSpec.location = String(item.location);
    }}
    if (hasText(item.description)) {{
      eventSpec.description = String(item.description);
    }}
    if (event) {{
      event.summary = eventSpec.summary;
      event.startDate = eventSpec.startDate;
      event.endDate = eventSpec.endDate;
      if (hasText(item.location)) {{
        event.location = String(item.location);
      }} else {{
        event.location = null;
      }}
      if (hasText(item.description)) {{
        event.description = String(item.description);
      }} else {{
        event.description = null;
      }}
    }} else {{
      event = Calendar.Event(eventSpec);
      defaultCalendar.events.push(event);
    }}
    return {{
      localId: item.localId,
      systemId: String(event.uid()),
      localModifiedAt: item.localModifiedAt,
      platform: payload.platform,
    }};
  }});
  console.log(JSON.stringify(result));
}}
main();
"#,
        payload
    )
}

fn run_osascript_jxa(payload: &serde_json::Value) -> Result<serde_json::Value, String> {
    let script = build_jxa_script(payload);
    let output = Command::new("osascript")
        .arg("-l")
        .arg("JavaScript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "系统日历同步失败".to_string()
        } else {
            stderr
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return Ok(json!([]));
    }
    serde_json::from_str(&stdout).map_err(|e| e.to_string())
}

fn run_pull_script() -> String {
    r#"
const Calendar = Application("Calendar");
Calendar.includeStandardAdditions = true;
const markerPrefix = "PIKO_SYNC local_id=";
const result = [];
const calendars = Calendar.calendars();
for (let i = 0; i < calendars.length; i += 1) {
  const calendar = calendars[i];
  const events = calendar.events;
  for (let j = 0; j < events.length; j += 1) {
    const event = events[j];
    const description = String(event.description ? event.description() : "");
    const markerIndex = description.indexOf(markerPrefix);
    const systemId = String(event.uid());
    const localId = markerIndex >= 0
      ? description.slice(markerIndex + markerPrefix.length).split(/\r?\n/)[0].trim()
      : "";
    if (markerIndex >= 0 && !localId) continue;
    const startDate = new Date(event.startDate());
    const endDate = new Date(event.endDate());
    result.push({
      localId,
      systemId,
      title: String(event.summary()),
      startAt: Math.floor(startDate.getTime() / 1000),
      endAt: Math.floor(endDate.getTime() / 1000),
      location: event.location ? String(event.location()) : null,
      notes: (() => {
        const raw = markerIndex >= 0 ? description.slice(0, markerIndex).trim() : description.trim();
        return raw.length ? raw : null;
      })(),
      systemModifiedAt: Math.floor((event.modificationDate ? new Date(event.modificationDate()) : new Date()).getTime() / 1000),
      platform: "macos",
    });
  }
}
console.log(JSON.stringify(result));
"#
    .to_string()
}

/// Push local events into the system calendar.
pub(crate) fn push_to_system_calendar(
    app: &AppHandle,
    events: &[CalendarEvent],
) -> Result<PushResult, String> {
    if !is_sync_available() {
        return Err("当前平台尚未开放系统日历同步".to_string());
    }

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

    let output = run_osascript_jxa(&json!({
        "platform": platform,
        "calendarName": system_calendar_name(),
        "events": payload_events,
    }))?;

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
    if !is_sync_available() {
        return Err("当前平台尚未开放系统日历同步".to_string());
    }

    let deleted_ids = read_deleted_local_ids(app);
    let system_events = read_system_events(since)?
        .into_iter()
        .filter(|event| !deleted_ids.contains(&event.resolved_local_id()))
        .collect::<Vec<_>>();
    let mut events = system_events
        .iter()
        .map(SystemCalendarEvent::to_calendar_event)
        .collect::<Vec<_>>();
    exclude_deleted_local_events(&mut events, &deleted_ids);
    if events.is_empty() {
        return Ok(PullResult {
            imported: 0,
            events,
        });
    }

    let mut local_events = read_local_calendar_events(app);
    let mut known_ids = local_events
        .iter()
        .map(|event| event.id.clone())
        .collect::<std::collections::HashSet<_>>();

    let mut imported = 0usize;
    for event in events.drain(..) {
        if let Some(existing) = local_events.iter_mut().find(|item| item.id == event.id) {
            *existing = event.clone();
        } else if known_ids.insert(event.id.clone()) {
            local_events.push(event.clone());
            imported += 1;
        }
    }

    update_mappings_from_system_events(app, &system_events)?;

    local_events.sort_by_key(|a| a.start_at);
    persist_local_calendar_events(app, &local_events)?;

    Ok(PullResult {
        imported,
        events: local_events,
    })
}

fn exclude_deleted_local_events(events: &mut Vec<CalendarEvent>, deleted_ids: &HashSet<String>) {
    events.retain(|event| !deleted_ids.contains(&event.id));
}

fn update_mappings_from_system_events(
    app: &AppHandle,
    system_events: &[SystemCalendarEvent],
) -> Result<(), String> {
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

    let stdout = Command::new("osascript")
        .arg("-l")
        .arg("JavaScript")
        .arg("-e")
        .arg(run_pull_script())
        .output()
        .map_err(|e| e.to_string())?;

    if !stdout.status.success() {
        let stderr = String::from_utf8_lossy(&stdout.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "读取系统日历失败".to_string()
        } else {
            stderr
        });
    }

    let raw = String::from_utf8_lossy(&stdout.stdout).trim().to_string();
    let system_events: Vec<SystemCalendarEvent> = if raw.is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(&raw).map_err(|e| e.to_string())?
    };

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

fn read_local_calendar_events(app: &AppHandle) -> Vec<CalendarEvent> {
    calendar_events_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn persist_local_calendar_events(app: &AppHandle, events: &[CalendarEvent]) -> Result<(), String> {
    let path = calendar_events_path(app).ok_or_else(|| "无法获取日程记录路径".to_string())?;
    let dir = path
        .parent()
        .ok_or_else(|| "无法获取日程记录目录".to_string())?;
    let json = serde_json::to_string_pretty(events).map_err(|e| e.to_string())?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn calendar_events_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("calendar-events.json"))
}

#[cfg(test)]
mod tests {
    use super::{exclude_deleted_local_events, local_id_for_system_event, SystemCalendarEvent};
    use crate::CalendarEvent;
    use std::collections::HashSet;

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
