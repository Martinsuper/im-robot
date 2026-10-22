use super::{Reminder, ReminderDeleteInput, ReminderInput};
use crate::agent_operations;
use crate::common::tool_timestamp;
use crate::common::tool_timestamp_str;
use crate::common::unix_timestamp;
use crate::schedule;
use crate::schedule::repository::{
    load_schedule_items, persist_schedule_items, read_schedule_items,
};
use crate::storage;
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub(crate) fn default_repeat_rule() -> String {
    "none".to_string()
}

/// 提醒视图。**唯一数据源是 schedule-items.json**，旧 reminders.json 只作归档。
///
/// 读失败时返回空列表，与改动前 `read_or_default` 的行为一致（旧实现遇到损坏文件
/// 也是返回空），因此没有引入新的失败模式。
pub(crate) fn read_reminders(app: &AppHandle) -> Vec<Reminder> {
    match read_schedule_items(app) {
        Ok(items) => schedule::reminders_view(&items),
        Err(error) => {
            eprintln!("[schedule] 读取提醒视图失败：{error}");
            Vec::new()
        }
    }
}

pub(crate) fn persist_reminders(app: &AppHandle, reminders: &[Reminder]) -> Result<(), String> {
    let _transaction = storage::transaction();
    // 严格模式：迁移未完成时报错，而不是把数据悄悄写进另一份存储。
    let existing = load_schedule_items(app, false)?;
    let next = schedule::merge_reminders(&existing, reminders);
    persist_schedule_items(app, &next)
}

pub(crate) fn reminder_id() -> String {
    format!(
        "reminder-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

pub(crate) fn repeat_rule_label(repeat: &str) -> &str {
    match repeat {
        "daily" => "每天",
        "weekly" => "每周",
        "weekdays" => "工作日",
        _ => "仅一次",
    }
}

pub(crate) fn reminder_input_from_value(value: &Value) -> Result<ReminderInput, String> {
    let title = value["title"]
        .as_str()
        .ok_or_else(|| "提醒标题不能为空".to_string())?
        .to_string();
    let due_at = tool_timestamp(&value["dueAt"])?;
    let repeat = value["repeat"].as_str().unwrap_or("none").to_string();
    Ok(ReminderInput {
        title,
        due_at,
        repeat,
    })
}

pub(crate) fn reminder_delete_input_from_value(
    value: &Value,
) -> Result<ReminderDeleteInput, String> {
    let id = value["id"]
        .as_str()
        .ok_or_else(|| "提醒 ID 不能为空".to_string())?
        .to_string();
    Ok(ReminderDeleteInput {
        id,
        title: value["title"].as_str().map(str::to_string),
        due_at: value["dueAt"].as_str().and_then(tool_timestamp_str),
        repeat: value["repeat"].as_str().map(str::to_string),
    })
}

pub(crate) fn create_reminder_record(
    app: &AppHandle,
    input: ReminderInput,
) -> Result<Reminder, String> {
    let _transaction = storage::transaction();
    let checkpoint_id = agent_operations::next_id("reminder");
    if let Some(existing) = read_reminders(app)
        .iter()
        .find(|item| checkpoint_id.as_ref() == Some(&item.id))
    {
        if existing.title == input.title.trim()
            && existing.due_at == input.due_at
            && existing.repeat == input.repeat
        {
            return Ok(existing.clone());
        }
        return Err("提醒已被修改，不能按原检查点覆盖，请先核对".into());
    }
    if !agent_operations::may_create() {
        return Err("提醒未在检查点中找到，不能自动重建，请先核对".into());
    }
    let title = input.title.trim();
    if title.is_empty() {
        return Err("提醒内容不能为空".to_string());
    }
    if title.chars().count() > 120 {
        return Err("提醒内容不能超过 120 个字符".to_string());
    }
    if input.due_at <= unix_timestamp() {
        return Err("提醒时间必须晚于当前时间".to_string());
    }
    if !matches!(
        input.repeat.as_str(),
        "none" | "daily" | "weekly" | "weekdays"
    ) {
        return Err("不支持的重复提醒规则".to_string());
    }

    let reminder = Reminder {
        id: checkpoint_id.unwrap_or_else(reminder_id),
        title: title.to_string(),
        due_at: input.due_at,
        status: "pending".to_string(),
        repeat: input.repeat,
    };
    let mut reminders = read_reminders(app);
    reminders.push(reminder.clone());
    persist_reminders(app, &reminders)?;
    let _ = app.emit("reminders-updated", ());
    Ok(reminder)
}

pub(crate) fn delete_reminder_record(
    app: &AppHandle,
    input: ReminderDeleteInput,
) -> Result<Reminder, String> {
    let _transaction = storage::transaction();
    let mut reminders = read_reminders(app);
    let index = reminders
        .iter()
        .position(|reminder| reminder.id == input.id)
        .ok_or_else(|| "未找到该提醒".to_string())?;
    let deleted = reminders.remove(index);
    persist_reminders(app, &reminders)?;
    let _ = app.emit("reminders-updated", ());
    Ok(deleted)
}
