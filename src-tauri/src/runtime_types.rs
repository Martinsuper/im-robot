//! Typed runtime state and events shared by chat and desktop features.
use crate::actions::ActionDraft;
use crate::chat_session::ChatHistoryEntry;
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatStartInput {
    pub(crate) request_id: String,
    pub(crate) prompt: String,
    pub(crate) attachment_action: Option<String>,
    pub(crate) include_screenshot: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub(crate) enum ChatEvent {
    Started {
        request_id: String,
        working: bool,
    },
    Delta {
        request_id: String,
        sequence: u64,
        text: String,
    },
    Completed {
        request_id: String,
    },
    ActionProposed {
        request_id: String,
        draft: ActionDraft,
    },
    Cancelled {
        request_id: String,
    },
    Failed {
        request_id: String,
        message: String,
    },
}

/// Emitted when memory candidates are auto-captured from a chat round.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryCapturedEvent {
    pub(crate) confirmed: usize,
    pub(crate) pending: usize,
}

#[derive(Default)]
pub(crate) struct ChatRequests(pub(crate) Mutex<HashMap<String, CancellationToken>>);

#[derive(Default)]
pub(crate) struct ChatContext(pub(crate) Mutex<Vec<ChatHistoryEntry>>);

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum StreamChatOutcome {
    Completed,
    Cancelled,
    ActionProposed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub(crate) enum PetVisualEvent {
    AttachmentReady,
    ReminderFired { message: String },
    CalendarEventDue { message: String },
    AmbientNudge,
    BreakReminder { message: String },
    IdleStarted,
    IdleEnded,
    FocusStarted,
    FocusCompleted,
}

pub(crate) fn append_session_chat_history(
    history: &mut Vec<ChatHistoryEntry>,
    entry: ChatHistoryEntry,
) {
    const MAX_SESSION_CHAT_HISTORY: usize = 10;

    history.insert(0, entry);
    history.truncate(MAX_SESSION_CHAT_HISTORY);
}
