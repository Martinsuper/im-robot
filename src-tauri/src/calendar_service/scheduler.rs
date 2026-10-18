use super::{service::read_calendar_events, CalendarEvent, CalendarNotificationCache};
use crate::storage;
use crate::common::unix_timestamp;
use crate::runtime_types::PetVisualEvent;
use std::{collections::HashSet, thread, time::Duration};
use tauri::{AppHandle, Emitter, Manager};

pub(crate) fn collect_due_calendar_events(
    events: &[CalendarEvent],
    now: u64,
    already_notified: &mut HashSet<String>,
) -> Vec<CalendarEvent> {
    const CALENDAR_EVENT_NOTICE_WINDOW_SECONDS: u64 = 60;

    events
        .iter()
        .filter(|event| {
            event.start_at <= now
                && now.saturating_sub(event.start_at) <= CALENDAR_EVENT_NOTICE_WINDOW_SECONDS
                && already_notified.insert(event.id.clone())
        })
        .cloned()
        .collect()
}

pub(crate) fn format_calendar_notice(event: &CalendarEvent) -> String {
    match event
        .location
        .as_deref()
        .map(str::trim)
        .filter(|location| !location.is_empty())
    {
        Some(location) => format!("日程：{} · {}", event.title, location),
        None => format!("日程：{}", event.title),
    }
}

pub(crate) fn process_due_calendar_events(app: &AppHandle) -> Result<Vec<CalendarEvent>, String> {
    let now = unix_timestamp();
    let events = read_calendar_events(app);
    let calendar_notifications = app.state::<CalendarNotificationCache>();
    let mut already_notified = calendar_notifications
        .0
        .lock()
        .map_err(|_| "无法读取日程提醒状态".to_string())?;
    let due = collect_due_calendar_events(&events, now, &mut already_notified);
    drop(already_notified);

    for event in &due {
        let message = format_calendar_notice(event);
        let _ = crate::notifications::send(app, "Piko 日程", &message);
        let _ = app.emit_to(
            "pet",
            "pet-visual-event",
            PetVisualEvent::CalendarEventDue { message },
        );
    }

    Ok(due)
}

pub(crate) fn watch_calendar_events(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || loop {
        let revision = storage::revision();
        if let Err(error) = process_due_calendar_events(&app) {
            eprintln!("[calendar] {error}");
        }
        let now = unix_timestamp();
        let delay = read_calendar_events(&app)
            .iter()
            .filter(|item| item.start_at > now)
            .map(|item| item.start_at.saturating_sub(now).clamp(1, 60))
            .min()
            .unwrap_or(60);
        storage::wait_for_change(revision, Duration::from_secs(delay));
    });
}
