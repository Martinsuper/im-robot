//! 提醒事项：提醒记录的持久化、增删改命令、插件工具入参解析，以及到期触发与重复规则推进的后台线程。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::PathBuf,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::{tool_timestamp, tool_timestamp_str, unix_timestamp, PetVisualEvent};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub id: String,
    pub title: String,
    pub due_at: u64,
    pub status: String,
    #[serde(default = "default_repeat_rule")]
    pub repeat: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderInput {
    pub title: String,
    pub due_at: u64,
    #[serde(default = "default_repeat_rule")]
    pub repeat: String,
}

fn default_repeat_rule() -> String {
    "none".to_string()
}

pub fn reminders_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("reminders.json"))
}

pub fn read_reminders(app: &AppHandle) -> Vec<Reminder> {
    reminders_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

pub fn persist_reminders(app: &AppHandle, reminders: &[Reminder]) -> Result<(), String> {
    let path = reminders_path(app).ok_or_else(|| "无法获取提醒记录路径".to_string())?;
    let directory = path
        .parent()
        .ok_or_else(|| "无法获取提醒记录目录".to_string())?;
    let json = serde_json::to_string(reminders).map_err(|error| error.to_string())?;

    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    fs::write(path, json).map_err(|error| error.to_string())
}

fn reminder_id() -> String {
    format!(
        "reminder-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

pub fn repeat_rule_label(repeat: &str) -> &str {
    match repeat {
        "daily" => "每天",
        "weekly" => "每周",
        "weekdays" => "工作日",
        _ => "仅一次",
    }
}

pub fn reminder_input_from_value(value: &Value) -> Result<ReminderInput, String> {
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

#[derive(Clone, Debug)]
pub struct ReminderDeleteInput {
    pub id: String,
    pub title: Option<String>,
    pub due_at: Option<u64>,
    pub repeat: Option<String>,
}

pub fn reminder_delete_input_from_value(value: &Value) -> Result<ReminderDeleteInput, String> {
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

#[tauri::command]
pub fn list_reminders(app: AppHandle) -> Vec<Reminder> {
    let mut reminders = read_reminders(&app);
    reminders.sort_by_key(|reminder| reminder.due_at);
    reminders
}

pub fn create_reminder_record(app: &AppHandle, input: ReminderInput) -> Result<Reminder, String> {
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
        id: reminder_id(),
        title: title.to_string(),
        due_at: input.due_at,
        status: "pending".to_string(),
        repeat: input.repeat,
    };
    let mut reminders = read_reminders(app);
    reminders.push(reminder.clone());
    persist_reminders(app, &reminders)?;
    let _ = app.emit_to("panel", "reminders-updated", ());
    Ok(reminder)
}

pub fn delete_reminder_record(
    app: &AppHandle,
    input: ReminderDeleteInput,
) -> Result<Reminder, String> {
    let mut reminders = read_reminders(app);
    let index = reminders
        .iter()
        .position(|reminder| reminder.id == input.id)
        .ok_or_else(|| "未找到该提醒".to_string())?;
    let deleted = reminders.remove(index);
    persist_reminders(app, &reminders)?;
    let _ = app.emit_to("panel", "reminders-updated", ());
    Ok(deleted)
}

#[tauri::command]
pub fn create_reminder(app: AppHandle, input: ReminderInput) -> Result<Reminder, String> {
    create_reminder_record(&app, input)
}

#[tauri::command]
pub fn delete_reminder(app: AppHandle, id: String) -> Result<(), String> {
    let mut reminders = read_reminders(&app);
    let previous_len = reminders.len();
    reminders.retain(|reminder| reminder.id != id);
    if reminders.len() == previous_len {
        return Err("未找到该提醒".to_string());
    }
    persist_reminders(&app, &reminders)?;
    let _ = app.emit_to("panel", "reminders-updated", ());
    Ok(())
}

pub fn collect_due_reminders(reminders: &mut [Reminder], now: u64) -> Vec<Reminder> {
    let mut due = Vec::new();
    for reminder in reminders {
        if reminder.status == "pending" && reminder.due_at <= now {
            due.push(reminder.clone());
            if reminder.repeat == "none" {
                reminder.status = "triggered".to_string();
            } else {
                reminder.due_at = next_repeat_due(reminder.due_at, &reminder.repeat, now);
            }
        }
    }
    due
}

pub fn next_repeat_due(mut due_at: u64, repeat: &str, now: u64) -> u64 {
    loop {
        due_at += match repeat {
            "weekly" => 7 * 24 * 60 * 60,
            _ => 24 * 60 * 60,
        };
        if repeat == "weekdays" {
            while matches!((due_at / 86_400 + 4) % 7, 0 | 6) {
                due_at += 24 * 60 * 60;
            }
        }
        if due_at > now {
            return due_at;
        }
    }
}

pub fn process_due_reminders(app: &AppHandle) -> Result<Vec<Reminder>, String> {
    let now = unix_timestamp();
    let mut reminders = read_reminders(app);
    let due = collect_due_reminders(&mut reminders, now);
    if due.is_empty() {
        return Ok(due);
    }

    persist_reminders(app, &reminders)?;
    for reminder in &due {
        let _ = app
            .notification()
            .builder()
            .title("Piko 提醒")
            .body(&reminder.title)
            .show();
        let _ = app.emit_to(
            "pet",
            "pet-visual-event",
            PetVisualEvent::ReminderFired {
                message: format!("提醒：{}", reminder.title),
            },
        );
    }
    let _ = app.emit_to("panel", "reminders-updated", ());
    Ok(due)
}

pub fn watch_reminders(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || loop {
        let _ = process_due_reminders(&app);
        thread::sleep(Duration::from_secs(1));
    });
}
