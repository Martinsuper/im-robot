//! Timeline IPC adapters.
use super::{
    repository::{load_schedule_items, persist_schedule_items, read_schedule_items},
    sort_schedule_items, ScheduleItem, ScheduleKind,
};
use crate::storage;
use tauri::AppHandle;

/// 统一时间线视图：按时间排序后返回，供「今天」使用。
#[tauri::command]
pub(crate) fn list_schedule_items(app: AppHandle) -> Result<Vec<ScheduleItem>, String> {
    let mut items = read_schedule_items(&app)?;
    sort_schedule_items(&mut items);
    Ok(items)
}

/// 「今天」时间线上的 ✓ 完成。
///
/// 只对提醒有意义：日程是「某个时段安排的事」，到点就过去了，没有完成态。
/// 对日程调用会明确报错，而不是悄悄把它标成 done 让用户以为删掉了。
#[tauri::command]
pub(crate) fn complete_schedule_item(app: AppHandle, id: String) -> Result<ScheduleItem, String> {
    let _transaction = storage::transaction();
    let mut items = load_schedule_items(&app, false)?;
    let index = items
        .iter()
        .position(|item| item.id == id)
        .ok_or_else(|| "这条记录已不存在，请刷新后重试".to_string())?;
    if items[index].kind != ScheduleKind::Reminder {
        return Err("日程没有完成状态，请直接删除或修改时间".to_string());
    }
    items[index].status = Some("done".to_string());
    let updated = items[index].clone();
    persist_schedule_items(&app, &items)?;
    Ok(updated)
}
