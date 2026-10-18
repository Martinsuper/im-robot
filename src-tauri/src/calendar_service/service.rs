use crate::schedule::repository::{load_schedule_items, persist_schedule_items, read_schedule_items};
use super::{
    CalendarDeleteBatchInput, CalendarDeleteInput, CalendarEvent, CalendarEventBatchInput,
    CalendarEventInput,
};
use crate::agent_operations;
use crate::schedule;
use crate::storage;
use crate::common::tool_timestamp;
use crate::common::tool_timestamp_str;
use crate::common::unix_timestamp;
use serde_json::Value;
#[cfg(test)]
use std::path::Path;
use std::{
    collections::HashSet,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

/// 日程视图。同 `read_reminders`：统一存储在 schedule-items.json。
pub(crate) fn read_calendar_events(app: &AppHandle) -> Vec<CalendarEvent> {
    match read_schedule_items(app) {
        Ok(items) => schedule::calendar_view(&items),
        Err(error) => {
            eprintln!("[schedule] 读取日程视图失败：{error}");
            Vec::new()
        }
    }
}

#[cfg(test)]
pub(crate) fn read_calendar_events_from_path(path: &Path) -> Vec<CalendarEvent> {
    storage::read_or_default(path)
}

pub(crate) fn persist_calendar_events(
    app: &AppHandle,
    events: &[CalendarEvent],
) -> Result<(), String> {
    let _transaction = storage::transaction();
    let existing = load_schedule_items(app, false)?;
    let next = schedule::merge_calendar_events(&existing, events);
    persist_schedule_items(app, &next)
}

#[cfg(test)]
pub(crate) fn persist_calendar_events_to_path(
    path: &Path,
    events: &[CalendarEvent],
) -> Result<(), String> {
    storage::write(path, events)
}

pub(crate) fn calendar_event_id() -> String {
    format!(
        "calendar-event-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

pub(crate) fn find_calendar_conflicts(
    events: &[CalendarEvent],
    start_at: u64,
    end_at: u64,
) -> Vec<CalendarEvent> {
    events
        .iter()
        .filter(|event| event.start_at < end_at && start_at < event.end_at)
        .cloned()
        .collect()
}

pub(crate) fn calendar_event_input_from_value(value: &Value) -> Result<CalendarEventInput, String> {
    let title = value["title"]
        .as_str()
        .ok_or_else(|| "日程标题不能为空".to_string())?
        .to_string();
    let start_at = tool_timestamp(&value["startAt"])?;
    let end_at = tool_timestamp(&value["endAt"])?;
    let location = value["location"].as_str().map(str::to_string);
    let notes = value["notes"].as_str().map(str::to_string);
    Ok(CalendarEventInput {
        title,
        start_at,
        end_at,
        location,
        notes,
    })
}

pub(crate) fn calendar_event_batch_input_from_value(
    value: &Value,
) -> Result<CalendarEventBatchInput, String> {
    let events = value["events"]
        .as_array()
        .ok_or_else(|| "批量日程必须包含 events 数组".to_string())?;
    if events.is_empty() || events.len() > 20 {
        return Err("批量日程数量必须在 1 到 20 之间".to_string());
    }
    Ok(CalendarEventBatchInput {
        events: events
            .iter()
            .map(calendar_event_input_from_value)
            .collect::<Result<Vec<_>, _>>()?,
    })
}

pub(crate) fn calendar_delete_input_from_value(
    value: &Value,
) -> Result<CalendarDeleteInput, String> {
    let id = value["id"]
        .as_str()
        .ok_or_else(|| "日程 ID 不能为空".to_string())?
        .to_string();
    Ok(CalendarDeleteInput {
        id,
        title: value["title"].as_str().map(str::to_string),
        start_at: value["startAt"].as_str().and_then(tool_timestamp_str),
        end_at: value["endAt"].as_str().and_then(tool_timestamp_str),
    })
}

pub(crate) fn calendar_delete_batch_input_from_value(
    value: &Value,
) -> Result<CalendarDeleteBatchInput, String> {
    let events = value["events"]
        .as_array()
        .ok_or_else(|| "批量删除日程必须包含 events 数组".to_string())?;
    if events.is_empty() || events.len() > 100 {
        return Err("批量删除日程数量必须在 1 到 100 之间".to_string());
    }
    Ok(CalendarDeleteBatchInput {
        events: events
            .iter()
            .map(calendar_delete_input_from_value)
            .collect::<Result<Vec<_>, _>>()?,
    })
}

pub(crate) fn checkpoint_calendar_event(
    events: &[CalendarEvent],
    input: CalendarEventInput,
) -> Result<(CalendarEvent, bool), String> {
    let checkpoint_id = agent_operations::next_id("calendar-event");
    if let Some(existing) = events
        .iter()
        .find(|item| checkpoint_id.as_ref() == Some(&item.id))
    {
        let location = input.location.filter(|value| !value.trim().is_empty());
        let notes = input.notes.filter(|value| !value.trim().is_empty());
        if existing.title == input.title.trim()
            && existing.start_at == input.start_at
            && existing.end_at == input.end_at
            && existing.location == location
            && existing.notes == notes
        {
            return Ok((existing.clone(), false));
        }
        return Err("日程已被修改，不能按原检查点覆盖，请先核对".into());
    }
    if !agent_operations::may_create() {
        return Err("日程未在检查点中找到，不能自动重建，请先核对".into());
    }
    let mut event = calendar_event_from_input(input)?;
    if let Some(id) = checkpoint_id {
        event.id = id;
    }
    Ok((event, true))
}

pub(crate) fn create_calendar_event_record(
    app: &AppHandle,
    input: CalendarEventInput,
) -> Result<CalendarEvent, String> {
    let _transaction = storage::transaction();
    let mut events = schedule::calendar_view(&load_schedule_items(app, false)?);
    let (event, created) = checkpoint_calendar_event(&events, input)?;
    if !created {
        return Ok(event);
    }
    events.push(event.clone());
    persist_calendar_events(app, &events)?;
    let _ = app.emit("calendar-events-updated", ());
    Ok(event)
}

#[cfg(test)]
pub(crate) fn create_calendar_event_record_at_path(
    path: &Path,
    input: CalendarEventInput,
) -> Result<CalendarEvent, String> {
    let _transaction = storage::transaction();
    let mut events = read_calendar_events_from_path(path);
    let event = calendar_event_from_input(input)?;
    events.push(event.clone());
    persist_calendar_events_to_path(path, &events)?;
    Ok(event)
}

pub(crate) fn delete_calendar_event_record(
    app: &AppHandle,
    input: CalendarDeleteInput,
) -> Result<CalendarEvent, String> {
    let _transaction = storage::transaction();
    let mut events = read_calendar_events(app);
    let index = events
        .iter()
        .position(|event| event.id == input.id)
        .ok_or_else(|| "未找到该日程".to_string())?;
    let deleted = events.remove(index);
    persist_calendar_events(app, &events)?;
    crate::sync::calendar_sync::mark_local_events_deleted(app, std::slice::from_ref(&deleted.id))?;
    let _ = app.emit("calendar-events-updated", ());
    Ok(deleted)
}

pub(crate) fn delete_calendar_event_batch_record(
    app: &AppHandle,
    input: CalendarDeleteBatchInput,
) -> Result<Vec<CalendarEvent>, String> {
    let _transaction = storage::transaction();
    let mut events = schedule::calendar_view(&load_schedule_items(app, false)?);
    let deleted = remove_calendar_event_batch(&mut events, input)?;
    persist_calendar_events(app, &events)?;
    let deleted_ids = deleted
        .iter()
        .map(|event| event.id.clone())
        .collect::<Vec<_>>();
    crate::sync::calendar_sync::mark_local_events_deleted(app, &deleted_ids)?;
    let _ = app.emit("calendar-events-updated", ());
    Ok(deleted)
}

#[cfg(test)]
pub(crate) fn delete_calendar_event_batch_record_at_path(
    path: &Path,
    input: CalendarDeleteBatchInput,
) -> Result<Vec<CalendarEvent>, String> {
    let _transaction = storage::transaction();
    let mut events = read_calendar_events_from_path(path);
    let deleted = remove_calendar_event_batch(&mut events, input)?;
    persist_calendar_events_to_path(path, &events)?;
    Ok(deleted)
}

pub(crate) fn remove_calendar_event_batch(
    events: &mut Vec<CalendarEvent>,
    input: CalendarDeleteBatchInput,
) -> Result<Vec<CalendarEvent>, String> {
    if input.events.is_empty() {
        return Err("请至少选择一条日程".to_string());
    }
    let mut ids = HashSet::new();
    for event in &input.events {
        if !ids.insert(event.id.as_str()) {
            return Err(format!("批量删除日程中包含重复 ID：{}", event.id));
        }
    }

    let deleted = events
        .iter()
        .filter(|event| ids.contains(event.id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if deleted.len() != ids.len() {
        return Err("部分待删除日程已不存在，请重新查询日程后再试".to_string());
    }
    events.retain(|event| !ids.contains(event.id.as_str()));
    Ok(deleted)
}

pub(crate) fn calendar_conflict_note(
    existing_events: &[CalendarEvent],
    start_at: u64,
    end_at: u64,
) -> Option<String> {
    let conflicts = find_calendar_conflicts(existing_events, start_at, end_at);
    if conflicts.is_empty() {
        None
    } else {
        Some(format!(
            "提示：该时间段与已有 {} 条日程重叠，但已继续创建。",
            conflicts.len()
        ))
    }
}

pub(crate) fn calendar_event_from_input(
    input: CalendarEventInput,
) -> Result<CalendarEvent, String> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err("日程标题不能为空".to_string());
    }
    if title.chars().count() > 120 {
        return Err("日程标题不能超过 120 个字符".to_string());
    }
    if input.start_at <= unix_timestamp() {
        return Err("日程开始时间必须晚于当前时间".to_string());
    }
    if input.end_at <= input.start_at {
        return Err("日程结束时间必须晚于开始时间".to_string());
    }
    Ok(CalendarEvent {
        id: calendar_event_id(),
        title: title.to_string(),
        start_at: input.start_at,
        end_at: input.end_at,
        location: input.location.filter(|value| !value.trim().is_empty()),
        notes: input.notes.filter(|value| !value.trim().is_empty()),
    })
}

pub(crate) fn create_calendar_event_batch_record(
    app: &AppHandle,
    batch: CalendarEventBatchInput,
) -> Result<Vec<CalendarEvent>, String> {
    let _transaction = storage::transaction();
    let mut events = read_calendar_events(app);
    let mut created = Vec::with_capacity(batch.events.len());
    for input in batch.events {
        let (event, is_new) = checkpoint_calendar_event(&events, input)?;
        if is_new {
            events.push(event.clone());
        }
        created.push(event);
    }
    persist_calendar_events(app, &events)?;
    let _ = app.emit("calendar-events-updated", ());
    Ok(created)
}
