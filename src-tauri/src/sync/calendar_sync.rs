/// System calendar bidirectional sync module.
///
/// Three-layer architecture:
/// 1. Local data layer: calendar-events.json (already exists)
/// 2. Mapping layer: local ID <-> system calendar ID correspondence
/// 3. Sync adapter layer: platform-specific calendar API implementations
///
/// Phased rollout:
/// Phase 1: One-way export to system calendar (push-only)
/// Phase 2: Pull changes from system calendar
/// Phase 3: Conflict resolution
///
/// Platform implementations:
/// - macOS: EventKit via objc2-event-kit
/// - Windows: .ics import/export fallback
/// - Linux: CalDAV via reqwest

use serde::{Deserialize, Serialize};
use tauri::Manager;

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
    true
}

/// Read sync mappings from file.
pub fn read_sync_mappings(app: &tauri::AppHandle) -> Vec<CalendarSyncMapping> {
    sync_mapping_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

/// Persist sync mappings to file.
pub fn persist_sync_mappings(
    app: &tauri::AppHandle,
    mappings: &[CalendarSyncMapping],
) -> Result<(), String> {
    let path = sync_mapping_path(app).ok_or_else(|| "无法获取同步映射路径".to_string())?;
    let dir = path.parent().ok_or_else(|| "无法获取同步映射目录".to_string())?;
    let json = serde_json::to_string(mappings).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

fn sync_mapping_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("calendar-sync-mapping.json"))
}

/// Push events to system calendar.
/// Returns the number of events pushed.
pub fn push_to_system_calendar(_event_count: usize) -> Result<usize, String> {
    // TODO: Platform-specific implementation
    // - macOS: EventKit via objc2-event-kit
    // - Windows: .ics import/export
    // - Linux: CalDAV
    #[cfg(target_os = "macos")]
    {
        // objc2-event-kit integration goes here
        return Err("macOS EventKit sync not yet implemented".to_string());
    }
    #[cfg(not(target_os = "macos"))]
    {
        return Err("System calendar sync not yet implemented for this platform".to_string());
    }
}

/// Pull events from system calendar.
pub fn pull_from_system_calendar(_since: u64) -> Result<usize, String> {
    // TODO: Platform-specific implementation
    Err("System calendar pull not yet implemented".to_string())
}
