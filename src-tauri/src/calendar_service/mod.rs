pub(crate) mod commands;
mod icalendar;
mod scheduler;
mod service;
pub(crate) use scheduler::watch_calendar_events;
use serde::{Deserialize, Serialize};
pub(crate) use service::*;
use std::{collections::HashSet, sync::Mutex};

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CalendarEvent {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) start_at: u64,
    pub(crate) end_at: u64,
    pub(crate) location: Option<String>,
    pub(crate) notes: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CalendarEventInput {
    pub(crate) title: String,
    pub(crate) start_at: u64,
    pub(crate) end_at: u64,
    pub(crate) location: Option<String>,
    pub(crate) notes: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct CalendarEventBatchInput {
    pub(crate) events: Vec<CalendarEventInput>,
}

#[derive(Default)]
pub(crate) struct CalendarNotificationCache(pub(crate) Mutex<HashSet<String>>);

#[derive(Clone, Debug)]
pub(crate) struct CalendarDeleteInput {
    pub(crate) id: String,
    pub(crate) title: Option<String>,
    pub(crate) start_at: Option<u64>,
    pub(crate) end_at: Option<u64>,
}

#[derive(Clone, Debug)]
pub(crate) struct CalendarDeleteBatchInput {
    pub(crate) events: Vec<CalendarDeleteInput>,
}

#[cfg(test)]
mod tests;
