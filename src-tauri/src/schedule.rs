//! R1 · 提醒与日程的统一模型（`ScheduleItem`）与旧数据迁移。
//!
//! # 为什么要合并
//!
//! R0 结束时是两套并行存储：
//!
//! ```text
//! reminders.json        → Vec<Reminder>      { id, title, dueAt, status, repeat }
//! calendar-events.json  → Vec<CalendarEvent> { id, title, startAt, endAt, location, notes }
//! ```
//!
//! 它们描述的是同一件事——「某个时间点要做的事」，但用户面对两个入口、两个表单、
//! 两份列表，不知道该往哪记（08 §2 的 IA-2 / IA-5）。本模块把它们收敛成一个
//! `ScheduleItem`，用 `kind` 区分。
//!
//! # 本步骤的边界（重要）
//!
//! 只做「模型 + 迁移」，**不修改任何现有读写路径**：旧文件仍被原逻辑读写，
//! 新文件先建立并保持可用。等消费者（面板、提醒调度、日历同步）逐个切到
//! `ScheduleItem` 之后，旧文件才退役。这样迁移可以独立测试，且不会影响
//! 正在工作的提醒调度与系统日历同步。
//!
//! # 数据安全（对齐 08 §5 风险对策）
//!
//! - **迁移前备份**：旧文件复制到 `backups/schedule-r1-<时间戳>/`。
//! - **幂等**：靠 `schedule-migration.json` 里的版本号，重复调用是空操作。
//! - **旧数据保留一版**：迁移从不删除旧文件。
//! - **损坏即中止**：旧文件读不出来时报错中止，**不会**把「读失败」当成
//!   「没有数据」导入 0 条然后写下完成标记——那等于永久丢失用户的提醒。

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::{storage, unix_timestamp, CalendarEvent, Reminder};

/// 当前 ScheduleItem 架构版本。上升它即表示需要重新迁移。
pub(crate) const SCHEMA_VERSION: u32 = 1;

/// 新建项（非迁移而来）的 `source` 取值。
const SOURCE_USER: &str = "user";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ScheduleKind {
    /// 提醒：到点弹出通知，带 status / repeat。
    Reminder,
    /// 日程：有起止时间，可带地点与备注，可同步到系统日历。
    Event,
}

/// 时间线上的一件事。提醒与日程的唯一模型（00 §6.2）。
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScheduleItem {
    pub(crate) id: String,
    pub(crate) kind: ScheduleKind,
    pub(crate) title: String,
    /// 时间线排序与展示的唯一时间起点：提醒取 `dueAt`，日程取 `startAt`。
    pub(crate) start_at: u64,
    /// 仅日程有结束时间。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) end_at: Option<u64>,
    /// 仅提醒：`pending` | `triggered`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) status: Option<String>,
    /// 仅提醒：`none` | `daily` | `weekly` | `weekdays`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) repeat: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) location: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) notes: Option<String>,
    /// 来源。R1 期间用它回查某条记录是哪个旧文件来的，便于出错时定位；
    /// 用户新建的写 `"user"`。
    #[serde(default = "default_source")]
    pub(crate) source: String,
}

fn default_source() -> String {
    SOURCE_USER.to_string()
}

impl ScheduleItem {
    /// 由旧提醒映射而来。保留原 id，便于 R1 期间用 id 反查旧记录。
    pub(crate) fn from_reminder(reminder: &Reminder) -> Self {
        Self {
            id: reminder.id.clone(),
            kind: ScheduleKind::Reminder,
            title: reminder.title.clone(),
            start_at: reminder.due_at,
            end_at: None,
            status: Some(reminder.status.clone()),
            repeat: Some(reminder.repeat.clone()),
            location: None,
            notes: None,
            source: "migrated:reminders.json".to_string(),
        }
    }

    /// 由旧日程映射而来。
    pub(crate) fn from_calendar_event(event: &CalendarEvent) -> Self {
        Self {
            id: event.id.clone(),
            kind: ScheduleKind::Event,
            title: event.title.clone(),
            start_at: event.start_at,
            end_at: Some(event.end_at),
            status: None,
            repeat: None,
            location: event.location.clone(),
            notes: event.notes.clone(),
            source: "migrated:calendar-events.json".to_string(),
        }
    }
}

/// 时间线顺序：先按时间，再按 id。id 参与比较是为了让同一时刻的多条记录
/// 有稳定顺序——否则每次读盘的渲染顺序可能不同，列表会「自己跳」。
pub(crate) fn sort_schedule_items(items: &mut [ScheduleItem]) {
    items.sort_by(|left, right| {
        left.start_at
            .cmp(&right.start_at)
            .then_with(|| left.id.cmp(&right.id))
    });
}

/// 迁移未完成时的**只读**兜底：直接把旧文件投影成 `ScheduleItem`。
///
/// 存在的理由：切换数据源之后，`read_reminders` 不再读 `reminders.json`。
/// 如果迁移因故失败（备份目录建不出来、标记文件不一致等），用户会突然在界面上
/// 看到「什么都没有」——而改动前他至少能看到旧数据。
///
/// 注意这是**只读**的：绝不写回。写入路径必须走 `load_items_for_write`，
/// 它在迁移未完成时直接报错。否则就会在迁移没完成的情况下悄悄制造出
/// 「旧文件 + 新文件」两份数据源，正是本次重构要消灭的东西。
pub(crate) fn legacy_projection_at(
    reminders_path: &Path,
    events_path: &Path,
) -> Result<Vec<ScheduleItem>, String> {
    let reminders: Vec<Reminder> = storage::read(reminders_path)?;
    let events: Vec<CalendarEvent> = storage::read(events_path)?;
    let mut items: Vec<ScheduleItem> = Vec::with_capacity(reminders.len() + events.len());
    items.extend(reminders.iter().map(ScheduleItem::from_reminder));
    items.extend(events.iter().map(ScheduleItem::from_calendar_event));
    sort_schedule_items(&mut items);
    Ok(items)
}

// ---------------------------------------------------------------------------
// 兼容投影：让旧调用点在一次都不改的前提下，把统一存储当成唯一数据源
// ---------------------------------------------------------------------------
//
// 现状（R1-1 之后）是「三份数据」：旧 reminders.json、旧 calendar-events.json、
// 新 schedule-items.json。如果提醒调度器读旧文件、面板写新文件，就会出现
// 「界面上删掉了一条提醒，但到点还是弹通知」这类无法解释的行为。
//
// 做法：**保持 `read_reminders` / `persist_reminders` / `read_calendar_events` /
// `persist_calendar_events` 的签名不变，只换实现**——它们改为从 `ScheduleItem`
// 投影与合并。这样 19 + 30 个调用点全部无需改动，旧文件退化为只读归档。
//
// 下面是这条链路的纯函数部分，因此可以被完整单测覆盖。

/// 从统一存储投影出「提醒视图」。
///
/// 保留了 `Reminder` 的字段语义，供提醒调度、导出、旧面板继续使用。
/// `status` / `repeat` 缺失时回落到与旧数据一致的默认值，避免投影出
/// 语义不完整的记录。
pub(crate) fn reminders_view(items: &[ScheduleItem]) -> Vec<Reminder> {
    items
        .iter()
        .filter(|item| item.kind == ScheduleKind::Reminder)
        .map(|item| Reminder {
            id: item.id.clone(),
            title: item.title.clone(),
            due_at: item.start_at,
            status: item
                .status
                .clone()
                .unwrap_or_else(|| DEFAULT_REMINDER_STATUS.to_string()),
            repeat: item
                .repeat
                .clone()
                .unwrap_or_else(|| DEFAULT_REMINDER_REPEAT.to_string()),
        })
        .collect()
}

/// 从统一存储投影出「日程视图」。
pub(crate) fn calendar_view(items: &[ScheduleItem]) -> Vec<CalendarEvent> {
    items
        .iter()
        .filter(|item| item.kind == ScheduleKind::Event)
        .map(|item| CalendarEvent {
            id: item.id.clone(),
            title: item.title.clone(),
            start_at: item.start_at,
            // 缺 endAt 时退化为零长度，而不是丢弃这条日程——
            // 宁可显示成「同一时刻开始与结束」，也不能让记录消失。
            end_at: item.end_at.unwrap_or(item.start_at),
            location: item.location.clone(),
            notes: item.notes.clone(),
        })
        .collect()
}

/// 用一份完整的提醒列表替换统一存储里的提醒部分，日程部分原样保留。
///
/// 对应旧 `persist_reminders(app, &reminders)` 的语义：传入的即是提醒的全集。
pub(crate) fn merge_reminders(
    existing: &[ScheduleItem],
    reminders: &[Reminder],
) -> Vec<ScheduleItem> {
    let mut next: Vec<ScheduleItem> = existing
        .iter()
        .filter(|item| item.kind == ScheduleKind::Event)
        .cloned()
        .collect();
    next.extend(reminders.iter().map(ScheduleItem::from_reminder));
    next
}

/// 用一份完整的日程列表替换统一存储里的日程部分，提醒部分原样保留。
pub(crate) fn merge_calendar_events(
    existing: &[ScheduleItem],
    events: &[CalendarEvent],
) -> Vec<ScheduleItem> {
    let mut next: Vec<ScheduleItem> = existing
        .iter()
        .filter(|item| item.kind == ScheduleKind::Reminder)
        .cloned()
        .collect();
    next.extend(events.iter().map(ScheduleItem::from_calendar_event));
    next
}

const DEFAULT_REMINDER_STATUS: &str = "pending";
const DEFAULT_REMINDER_REPEAT: &str = "none";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScheduleMigrationReport {
    /// 本次调用是否什么也没做（此前已迁移过）。
    pub already_migrated: bool,
    pub reminders_imported: usize,
    pub events_imported: usize,
    /// 备份目录；本次未产生备份时为 None。
    pub backup_dir: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MigrationMarker {
    version: u32,
    migrated_at: u64,
    reminders: usize,
    events: usize,
}

/// 迁移的路径级实现。与 `AppHandle` 解耦，便于单测。
///
/// 调用方需自行持有 `storage::transaction()`，或使用 `lib.rs` 里的包装。
pub(crate) fn migrate_legacy_schedule_at(
    reminders_path: &Path,
    events_path: &Path,
    schedule_path: &Path,
    marker_path: &Path,
) -> Result<ScheduleMigrationReport, String> {
    let marker: MigrationMarker = storage::read_or_default(marker_path);
    if marker.version >= SCHEMA_VERSION {
        return Ok(ScheduleMigrationReport {
            already_migrated: true,
            reminders_imported: marker.reminders,
            events_imported: marker.events,
            backup_dir: None,
        });
    }

    // 有内容却没有标记，说明状态不一致（例如上一次迁移写了一半就被中断，或标记文件被
    // 手动删了）。这种情况不猜、不覆盖，直接报错交给人工确认。
    if !schedule_path.exists() {
        // 正常路径，继续。
    } else {
        let existing: Vec<ScheduleItem> = storage::read(schedule_path)?;
        if !existing.is_empty() {
            return Err(format!(
                "{} 已有 {} 条日程记录但缺少迁移标记，为避免覆盖已中止迁移。\
                 请人工确认保留哪一份后删除另一个文件。",
                schedule_path.display(),
                existing.len()
            ));
        }
    }

    // `storage::read` 把「文件不存在」当作空列表，把「文件损坏」当作错误。
    // 必须让它把错误抛出来：否则损坏会被当成「没有数据」，导入 0 条并写下完成标记，
    // 用户的提醒就永久消失了。
    let reminders: Vec<Reminder> = storage::read(reminders_path)?;
    let events: Vec<CalendarEvent> = storage::read(events_path)?;

    let mut items: Vec<ScheduleItem> = Vec::with_capacity(reminders.len() + events.len());
    items.extend(reminders.iter().map(ScheduleItem::from_reminder));
    items.extend(events.iter().map(ScheduleItem::from_calendar_event));
    sort_schedule_items(&mut items);

    // 先备份再落盘：备份失败就中止，宁可没迁移也不能没备份。
    let backup_dir = backup_legacy_files(reminders_path, events_path, schedule_path.parent())?;

    storage::write(schedule_path, &items)?;
    storage::write(
        marker_path,
        &MigrationMarker {
            version: SCHEMA_VERSION,
            migrated_at: unix_timestamp(),
            reminders: reminders.len(),
            events: events.len(),
        },
    )?;

    Ok(ScheduleMigrationReport {
        already_migrated: false,
        reminders_imported: reminders.len(),
        events_imported: events.len(),
        backup_dir,
    })
}

fn backup_legacy_files(
    reminders_path: &Path,
    events_path: &Path,
    base_dir: Option<&Path>,
) -> Result<Option<String>, String> {
    let Some(base_dir) = base_dir else {
        return Ok(None);
    };
    let directory: PathBuf = base_dir.join(format!("backups/schedule-r1-{}", unix_timestamp()));
    let mut created = false;
    for source in [reminders_path, events_path] {
        if !source.exists() {
            continue;
        }
        if !created {
            fs::create_dir_all(&directory).map_err(|error| format!("无法创建备份目录：{error}"))?;
            created = true;
        }
        let name = source.file_name().ok_or("备份文件名无效")?;
        fs::copy(source, directory.join(name))
            .map_err(|error| format!("无法备份 {}：{error}", source.display()))?;
    }
    Ok(created.then(|| directory.display().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Fixture {
        _directory: tempfile::TempDir,
        reminders: PathBuf,
        events: PathBuf,
        schedule: PathBuf,
        marker: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path();
            Self {
                reminders: root.join("reminders.json"),
                events: root.join("calendar-events.json"),
                schedule: root.join("schedule-items.json"),
                marker: root.join("schedule-migration.json"),
                _directory: directory,
            }
        }

        fn migrate(&self) -> Result<ScheduleMigrationReport, String> {
            migrate_legacy_schedule_at(&self.reminders, &self.events, &self.schedule, &self.marker)
        }

        fn write_legacy(&self, reminders: serde_json::Value, events: serde_json::Value) {
            fs::write(&self.reminders, reminders.to_string()).unwrap();
            fs::write(&self.events, events.to_string()).unwrap();
        }

        fn schedule_items(&self) -> Vec<ScheduleItem> {
            storage::read(&self.schedule).unwrap()
        }
    }

    fn legacy_reminder(id: &str, due_at: u64) -> serde_json::Value {
        json!({ "id": id, "title": "开会", "dueAt": due_at, "status": "pending", "repeat": "none" })
    }

    fn legacy_event(id: &str, start_at: u64, end_at: u64) -> serde_json::Value {
        json!({
            "id": id, "title": "评审", "startAt": start_at, "endAt": end_at,
            "location": "会议室", "notes": null
        })
    }

    /// 真实数据里系统同步过来的日程 id 长这样（见 calendar-sync-mapping.json 的 localId）。
    /// 迁移必须原样保留它，否则系统日历的 id 映射会全部失效。
    fn system_event_id() -> String {
        "system-macos-40A03588-791E-4CE1-89C1-2C455F4438EA3a4o0jqp2ambjo79k7iunvlrb77q40google2ecom"
            .to_string()
    }

    #[test]
    fn merges_both_sources_into_one_sorted_timeline() {
        let fixture = Fixture::new();
        fixture.write_legacy(
            json!([
                legacy_reminder("reminder-2", 200),
                legacy_reminder("reminder-1", 100)
            ]),
            json!([legacy_event("calendar-event-1", 150, 180)]),
        );

        let report = fixture.migrate().unwrap();
        assert!(!report.already_migrated);
        assert_eq!(report.reminders_imported, 2);
        assert_eq!(report.events_imported, 1);
        assert!(report.backup_dir.is_some());

        let items = fixture.schedule_items();
        assert_eq!(items.len(), 3);
        // 统一时间线：提醒与日程按时间交错排列，而不是两段拼在一起
        assert_eq!(
            items.iter().map(|item| item.start_at).collect::<Vec<_>>(),
            vec![100, 150, 200]
        );
    }

    #[test]
    fn keeps_kind_specific_fields_and_provenance() {
        let fixture = Fixture::new();
        fixture.write_legacy(
            json!([legacy_reminder("reminder-1", 100)]),
            json!([legacy_event("calendar-event-1", 150, 180)]),
        );
        fixture.migrate().unwrap();
        let items = fixture.schedule_items();

        let reminder = items
            .iter()
            .find(|item| item.kind == ScheduleKind::Reminder)
            .unwrap();
        assert_eq!(reminder.kind, ScheduleKind::Reminder);
        assert_eq!(reminder.status.as_deref(), Some("pending"));
        assert_eq!(reminder.repeat.as_deref(), Some("none"));
        assert!(reminder.end_at.is_none(), "提醒不应有结束时间");
        assert_eq!(reminder.source, "migrated:reminders.json");

        let event = items
            .iter()
            .find(|item| item.kind == ScheduleKind::Event)
            .unwrap();
        assert_eq!(event.kind, ScheduleKind::Event);
        assert_eq!(event.end_at, Some(180));
        assert_eq!(event.location.as_deref(), Some("会议室"));
        assert!(event.status.is_none(), "日程不应有提醒状态");
        assert_eq!(event.source, "migrated:calendar-events.json");
    }

    #[test]
    fn preserves_system_event_ids_so_calendar_sync_mapping_survives() {
        // calendar-sync-mapping.json 以 localId（= 日程 id）为键。若迁移改写 id，
        // 用户会看到系统日历事件被重复导入，或已同步的事件再也匹配不上。
        let fixture = Fixture::new();
        let id = system_event_id();
        fixture.write_legacy(
            json!([]),
            json!([{ "id": id, "title": "Xiamen GDG DevFest 2018", "startAt": 1543109400,
                     "endAt": 1543136400, "location": null, "notes": "见 meetup" }]),
        );

        fixture.migrate().unwrap();

        const MAPPING: &str = r#"[{"localId":"system-macos-40A03588-791E-4CE1-89C1-2C455F4438EA3a4o0jqp2ambjo79k7iunvlrb77q40google2ecom","systemId":"40A03588:791E"}]"#;
        let mapping: serde_json::Value = serde_json::from_str(MAPPING).unwrap();
        let mapped_local_id = mapping[0]["localId"].as_str().unwrap();

        let items = fixture.schedule_items();
        assert_eq!(items.len(), 1);
        assert_eq!(
            items[0].id, mapped_local_id,
            "迁移不得改写 system-* 形式的 id"
        );
        assert_eq!(items[0].source, "migrated:calendar-events.json");
    }

    #[test]
    fn carries_non_default_reminder_status_across_the_migration() {
        // 真实数据里存在 status = "triggered" 的历史提醒；默认值是 "pending"，
        // 若投影时回落成默认值，用户会看到已提醒过的事情又变回等待中。
        let fixture = Fixture::new();
        fixture.write_legacy(
            json!([{ "id": "reminder-1781220537736710000", "title": "早上打开",
                     "dueAt": 1781226000, "status": "triggered", "repeat": "none" }]),
            json!([]),
        );
        fixture.migrate().unwrap();

        let projected = reminders_view(&fixture.schedule_items());
        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0].status, "triggered");
        assert_eq!(projected[0].due_at, 1781226000);
    }

    #[test]
    fn migration_is_idempotent() {
        let fixture = Fixture::new();
        fixture.write_legacy(json!([legacy_reminder("reminder-1", 100)]), json!([]));

        let first = fixture.migrate().unwrap();
        assert!(!first.already_migrated);

        let second = fixture.migrate().unwrap();
        assert!(second.already_migrated, "第二次调用必须是空操作");
        assert_eq!(second.reminders_imported, 1, "应回放首次的结果口径");
        assert!(second.backup_dir.is_none(), "空操作不应再产生备份");
        assert_eq!(fixture.schedule_items().len(), 1, "不应重复导入");
    }

    #[test]
    fn corrupt_legacy_file_aborts_without_marker_or_partial_write() {
        let fixture = Fixture::new();
        fs::write(&fixture.reminders, "{broken").unwrap();
        fs::write(&fixture.events, json!([]).to_string()).unwrap();

        let error = fixture.migrate().unwrap_err();
        assert!(
            error.contains("reminders.json"),
            "错误要指出哪个文件坏了：{error}"
        );
        assert!(!fixture.marker.exists(), "失败时绝不能写下完成标记");
        assert!(
            !fixture.schedule.exists(),
            "失败时不应留下半截的 schedule 文件"
        );
    }

    #[test]
    fn refuses_to_clobber_existing_schedule_without_marker() {
        let fixture = Fixture::new();
        fixture.write_legacy(json!([legacy_reminder("reminder-1", 100)]), json!([]));
        // 模拟「写了一半被中断」：schedule 已有合法内容，但迁移标记缺失
        let existing = json!([{
            "id": "reminder-9",
            "kind": "reminder",
            "title": "已存在的记录",
            "startAt": 900,
            "status": "pending",
            "repeat": "none",
            "source": "user"
        }]);
        fs::write(&fixture.schedule, existing.to_string()).unwrap();

        let error = fixture.migrate().unwrap_err();
        assert!(error.contains("为避免覆盖"), "应明确告知为何中止：{error}");
        // 既有内容必须原样保留
        assert!(fs::read_to_string(&fixture.schedule)
            .unwrap()
            .contains("reminder-9"));
    }

    #[test]
    fn refuses_to_clobber_a_corrupt_existing_schedule_file() {
        let fixture = Fixture::new();
        fixture.write_legacy(json!([legacy_reminder("reminder-1", 100)]), json!([]));
        fs::write(&fixture.schedule, "{broken").unwrap();

        assert!(fixture.migrate().is_err());
        // 损坏的既有文件同样是「明文保留」，不能被迁移覆盖
        assert_eq!(fs::read_to_string(&fixture.schedule).unwrap(), "{broken");
        assert!(!fixture.marker.exists());
    }

    #[test]
    fn backs_up_legacy_files_before_writing() {
        let fixture = Fixture::new();
        let reminders = json!([legacy_reminder("reminder-1", 100)]).to_string();
        fixture.write_legacy(json!([legacy_reminder("reminder-1", 100)]), json!([]));

        let report = fixture.migrate().unwrap();
        let backup = PathBuf::from(report.backup_dir.unwrap());
        assert_eq!(
            fs::read_to_string(backup.join("reminders.json")).unwrap(),
            reminders
        );
        assert!(backup.join("calendar-events.json").exists());
    }

    #[test]
    fn fresh_install_migrates_to_empty_list() {
        let fixture = Fixture::new();
        let report = fixture.migrate().unwrap();
        assert!(!report.already_migrated);
        assert_eq!(report.reminders_imported, 0);
        assert_eq!(report.events_imported, 0);
        assert!(report.backup_dir.is_none(), "没有旧文件就不应造备份目录");
        assert!(fixture.schedule_items().is_empty());
    }

    #[test]
    fn legacy_files_are_never_deleted() {
        let fixture = Fixture::new();
        fixture.write_legacy(json!([legacy_reminder("reminder-1", 100)]), json!([]));
        fixture.migrate().unwrap();
        assert!(fixture.reminders.exists(), "旧数据要保留一版，供回滚与比对");
        assert!(fixture.events.exists());
    }

    fn reminder(id: &str, due_at: u64) -> Reminder {
        Reminder {
            id: id.into(),
            title: format!("提醒 {id}"),
            due_at,
            status: "pending".into(),
            repeat: "none".into(),
        }
    }

    fn event(id: &str, start_at: u64) -> CalendarEvent {
        CalendarEvent {
            id: id.into(),
            title: format!("日程 {id}"),
            start_at,
            end_at: start_at + 30,
            location: None,
            notes: None,
        }
    }

    #[test]
    fn views_round_trip_through_the_unified_store() {
        let reminders = vec![reminder("reminder-1", 100), reminder("reminder-2", 300)];
        let events = vec![event("calendar-event-1", 200)];

        let items = merge_calendar_events(&merge_reminders(&[], &reminders), &events);
        assert_eq!(items.len(), 3);

        // 两个视图各自保序，且互不串味
        assert_eq!(
            reminders_view(&items)
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["reminder-1", "reminder-2"]
        );
        assert_eq!(
            calendar_view(&items)
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["calendar-event-1"]
        );
        assert_eq!(reminders_view(&items), reminders);
        assert_eq!(calendar_view(&items), events);
    }

    #[test]
    fn merging_one_kind_never_disturbs_the_other() {
        let items = merge_calendar_events(
            &merge_reminders(&[], &[reminder("reminder-1", 100)]),
            &[event("calendar-event-1", 200)],
        );

        // 只写提醒：日程必须原样保留
        let after_reminders = merge_reminders(&items, &[reminder("reminder-9", 900)]);
        assert_eq!(after_reminders.len(), 2);
        assert_eq!(
            calendar_view(&after_reminders),
            vec![event("calendar-event-1", 200)]
        );
        assert_eq!(
            reminders_view(&after_reminders)
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["reminder-9"]
        );

        // 只写日程：提醒必须原样保留
        let after_events = merge_calendar_events(&after_reminders, &[]);
        assert_eq!(after_events.len(), 1);
        assert_eq!(reminders_view(&after_events).len(), 1);
        assert!(calendar_view(&after_events).is_empty());
    }

    #[test]
    fn projection_fills_missing_kind_fields_with_legacy_defaults() {
        // 迁移进来的记录一定有 status/repeat，但手工编辑过的文件可能没有。
        // 投影必须给出旧代码认得的默认值，而不是 None。
        let items = vec![ScheduleItem {
            id: "reminder-1".into(),
            kind: ScheduleKind::Reminder,
            title: "无状态提醒".into(),
            start_at: 100,
            end_at: None,
            status: None,
            repeat: None,
            location: None,
            notes: None,
            source: SOURCE_USER.into(),
        }];
        let projected = reminders_view(&items);
        assert_eq!(projected[0].status, "pending");
        assert_eq!(projected[0].repeat, "none");
    }

    #[test]
    fn event_projection_keeps_zero_length_instead_of_dropping() {
        let items = vec![ScheduleItem {
            id: "calendar-event-1".into(),
            kind: ScheduleKind::Event,
            title: "无结束时间".into(),
            start_at: 100,
            end_at: None,
            status: None,
            repeat: None,
            location: None,
            notes: None,
            source: SOURCE_USER.into(),
        }];
        let projected = calendar_view(&items);
        assert_eq!(projected.len(), 1, "不能因为缺 endAt 就丢掉整条日程");
        assert_eq!(projected[0].start_at, 100);
        assert_eq!(projected[0].end_at, 100);
    }

    #[test]
    fn legacy_projection_is_read_only_and_sorted() {
        let fixture = Fixture::new();
        fixture.write_legacy(
            json!([legacy_reminder("reminder-2", 200)]),
            json!([legacy_event("calendar-event-1", 100, 130)]),
        );

        let items = legacy_projection_at(&fixture.reminders, &fixture.events).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].start_at, 100, "兜底投影也应按时间排序");
        // 只读：不得产生任何新文件
        assert!(!fixture.schedule.exists());
        assert!(!fixture.marker.exists());
    }

    #[test]
    fn legacy_projection_reports_corruption_instead_of_pretending_empty() {
        let fixture = Fixture::new();
        fs::write(&fixture.reminders, "{broken").unwrap();
        fs::write(&fixture.events, json!([]).to_string()).unwrap();
        assert!(legacy_projection_at(&fixture.reminders, &fixture.events).is_err());
    }

    #[test]
    fn sort_is_stable_for_identical_timestamps() {
        let mut items = vec![
            ScheduleItem::from_reminder(&Reminder {
                id: "reminder-b".into(),
                title: "b".into(),
                due_at: 100,
                status: "pending".into(),
                repeat: "none".into(),
            }),
            ScheduleItem::from_reminder(&Reminder {
                id: "reminder-a".into(),
                title: "a".into(),
                due_at: 100,
                status: "pending".into(),
                repeat: "none".into(),
            }),
        ];
        sort_schedule_items(&mut items);
        assert_eq!(items[0].id, "reminder-a");
        assert_eq!(items[1].id, "reminder-b");
    }
}
