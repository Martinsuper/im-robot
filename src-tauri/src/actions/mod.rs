//! Shared pending-action contracts and module boundaries. Explicit resolution consumes each draft once.
pub(crate) mod commands;
pub(crate) mod drafts;
pub(crate) mod selection;
mod store;
pub(crate) use store::ActionDrafts;
#[cfg(test)]
mod tests;
use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActionDraft {
    pub(crate) id: String,
    pub(crate) plugin_id: String,
    pub(crate) tool_name: String,
    pub(crate) summary: String,
    pub(crate) arguments: Value,
    pub(crate) created_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActionExecution {
    pub(crate) message: String,
    pub(crate) result: Value,
    pub(crate) follow_up_prompt: String,
}
