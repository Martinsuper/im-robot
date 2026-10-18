//! Unified schedule storage orchestration and migration policy.
use super as schedule;
use crate::storage;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

pub(crate) fn reminders_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("reminders.json"))
}

pub(crate) fn calendar_events_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("calendar-events.json"))
}

pub(crate) fn schedule_items_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("schedule-items.json"))
}

fn schedule_migration_marker_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("schedule-migration.json"))
}

/// R1：把旧的 reminders.json / calendar-events.json 迁移进统一的 schedule-items.json。
///
/// 幂等；不删除旧文件；旧文件损坏时中止且不写完成标记。详见 `schedule` 模块文档。
pub(crate) fn migrate_schedule_items(
    app: &AppHandle,
) -> Result<schedule::ScheduleMigrationReport, String> {
    let _transaction = storage::transaction();
    let reminders = reminders_path(app).ok_or("无法获取提醒数据路径")?;
    let events = calendar_events_path(app).ok_or("无法获取日程数据路径")?;
    let items = schedule_items_path(app).ok_or("无法获取日程记录路径")?;
    let marker = schedule_migration_marker_path(app).ok_or("无法获取迁移标记路径")?;
    schedule::migrate_legacy_schedule_at(&reminders, &events, &items, &marker)
}

fn schedule_migration_done(app: &AppHandle) -> Result<bool, String> {
    let marker = schedule_migration_marker_path(app).ok_or("无法获取迁移标记路径")?;
    let value: serde_json::Value = storage::read_or_default(&marker);
    Ok(value
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .is_some_and(|version| version >= schedule::SCHEMA_VERSION as u64))
}

/// 读统一存储。迁移未完成时按需迁移。
///
/// `allow_legacy_fallback`：迁移失败时是否降级为「只读旧文件」。
/// 读路径传 true——宁可显示旧数据，也不能让用户以为提醒不见了；
/// 写路径传 false——迁移没完成就拒绝写入，绝不在旧文件之外再制造一份数据源。
pub(crate) fn load_schedule_items(
    app: &AppHandle,
    allow_legacy_fallback: bool,
) -> Result<Vec<schedule::ScheduleItem>, String> {
    let _transaction = storage::transaction();
    if !schedule_migration_done(app)? {
        match migrate_schedule_items(app) {
            Ok(_) => {}
            Err(error) if allow_legacy_fallback => {
                eprintln!("[schedule] 迁移未完成，读取降级为旧文件（只读）：{error}");
                let reminders = reminders_path(app).ok_or("无法获取提醒数据路径")?;
                let events = calendar_events_path(app).ok_or("无法获取日程数据路径")?;
                return schedule::legacy_projection_at(&reminders, &events);
            }
            Err(error) => return Err(error),
        }
    }
    let items_path = schedule_items_path(app).ok_or("无法获取日程记录路径")?;
    storage::read(&items_path)
}

/// 统一时间线读取入口（读路径，允许旧文件兜底）。
pub(crate) fn read_schedule_items(app: &AppHandle) -> Result<Vec<schedule::ScheduleItem>, String> {
    load_schedule_items(app, true)
}

/// 写回统一存储。调用方必须已持有 `storage::transaction()`。
pub(crate) fn persist_schedule_items(
    app: &AppHandle,
    items: &[schedule::ScheduleItem],
) -> Result<(), String> {
    let path = schedule_items_path(app).ok_or("无法获取日程记录路径")?;
    storage::write(&path, items)?;
    // 提醒与日程现在同源（schedule-items.json），所以广播也统一成一个事件。
    // 旧命令仍会各自发 reminders-updated / calendar-events-updated，保留是为了
    // 不打断尚未迁移的监听方，等 R1 收尾时清掉。
    let _ = app.emit("schedule-updated", ());
    Ok(())
}
