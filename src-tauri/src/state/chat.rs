use crate::types::{ActionDraft, ChatHistoryEntry};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{atomic::AtomicBool, Arc, Mutex};

#[derive(Default)]
pub struct ChatRequests(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

#[derive(Default)]
pub struct ChatContext(pub Mutex<Vec<ChatHistoryEntry>>);

pub fn append_session_chat_history(history: &mut Vec<ChatHistoryEntry>, entry: ChatHistoryEntry) {
    const MAX_SESSION_CHAT_HISTORY: usize = 10;

    history.insert(0, entry);
    history.truncate(MAX_SESSION_CHAT_HISTORY);
}
