use super::{service::*, Reminder, ReminderInput};
use crate::storage;
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub(crate) fn list_reminders(app: AppHandle) -> Vec<Reminder> {
    let mut reminders = read_reminders(&app);
    reminders.sort_by_key(|reminder| reminder.due_at);
    reminders
}

#[tauri::command]
pub(crate) fn create_reminder(app: AppHandle, input: ReminderInput) -> Result<Reminder, String> {
    create_reminder_record(&app, input)
}

#[tauri::command]
pub(crate) fn delete_reminder(app: AppHandle, id: String) -> Result<(), String> {
    let _transaction = storage::transaction();
    let mut reminders = read_reminders(&app);
    let previous_len = reminders.len();
    reminders.retain(|reminder| reminder.id != id);
    if reminders.len() == previous_len {
        return Err("未找到该提醒".to_string());
    }
    persist_reminders(&app, &reminders)?;
    let _ = app.emit("reminders-updated", ());
    Ok(())
}
