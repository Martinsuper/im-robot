pub(crate) mod commands;
mod scheduler;
mod service;
pub(crate) use scheduler::watch_reminders;
use serde::{Deserialize, Serialize};
use service::default_repeat_rule;
pub(crate) use service::*;

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reminder {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) due_at: u64,
    pub(crate) status: String,
    #[serde(default = "default_repeat_rule")]
    pub(crate) repeat: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReminderInput {
    pub(crate) title: String,
    pub(crate) due_at: u64,
    #[serde(default = "default_repeat_rule")]
    pub(crate) repeat: String,
}

#[derive(Clone, Debug)]
pub(crate) struct ReminderDeleteInput {
    pub(crate) id: String,
    pub(crate) title: Option<String>,
    pub(crate) due_at: Option<u64>,
    pub(crate) repeat: Option<String>,
}

#[cfg(test)]
mod tests;
