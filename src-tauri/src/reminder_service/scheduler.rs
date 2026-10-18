use super::{service::*, Reminder};
use crate::reminder_schedule::next_repeat_due;
use crate::storage;
use crate::common::unix_timestamp;
use crate::runtime_types::PetVisualEvent;
use std::{thread, time::Duration};
use tauri::{AppHandle, Emitter};

pub(crate) fn collect_due_reminders(reminders: &mut [Reminder], now: u64) -> Vec<Reminder> {
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

pub(crate) fn process_due_reminders(app: &AppHandle) -> Result<Vec<Reminder>, String> {
    let _transaction = storage::transaction();
    let now = unix_timestamp();
    let mut reminders = read_reminders(app);
    let due = collect_due_reminders(&mut reminders, now);
    if due.is_empty() {
        return Ok(due);
    }

    persist_reminders(app, &reminders)?;
    for reminder in &due {
        let _ = crate::notifications::send(app, "Piko 提醒", &reminder.title);
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

pub(crate) fn watch_reminders(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || loop {
        let revision = storage::revision();
        if let Err(error) = process_due_reminders(&app) {
            eprintln!("[reminders] {error}");
        }
        let now = unix_timestamp();
        let delay = read_reminders(&app)
            .iter()
            .filter(|item| item.status == "pending")
            .map(|item| item.due_at.saturating_sub(now).clamp(1, 60))
            .min()
            .unwrap_or(60);
        storage::wait_for_change(revision, Duration::from_secs(delay));
    });
}
