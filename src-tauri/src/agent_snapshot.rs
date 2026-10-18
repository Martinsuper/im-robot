//! In-memory UI recovery only. Never persists tool arguments or replays execution.
use serde::Serialize;
use serde_json::Value;
use std::collections::VecDeque;

const RECENT_TOOLS: usize = 64;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskSnapshot {
    pub request_id: String,
    pub conversation_id: String,
    pub cwd: Option<String>,
    pub prompt: String,
    pub response: String,
    pub event_sequence: u64,
    pub events: Vec<Value>,
}

impl TaskSnapshot {
    pub fn new(
        request_id: String,
        conversation_id: String,
        cwd: Option<String>,
        prompt: String,
    ) -> Self {
        Self {
            request_id,
            conversation_id,
            cwd,
            prompt,
            response: String::new(),
            event_sequence: 0,
            events: Vec::new(),
        }
    }

    pub fn terminal(&self) -> bool {
        self.events.last().is_some_and(|event| {
            matches!(
                event["type"].as_str(),
                Some("completed" | "failed" | "cancelled")
            )
        })
    }

    /// Called under the same lock as native event publication, ensuring snapshot/stream ordering.
    pub fn record(&mut self, event: &mut Value) -> bool {
        if event["requestId"].as_str() != Some(&self.request_id) || self.terminal() {
            return false;
        }
        self.event_sequence += 1;
        event["eventSequence"] = self.event_sequence.into();
        let kind = event["type"].as_str().unwrap_or("");
        match kind {
            "delta" => {
                self.response.push_str(event["text"].as_str().unwrap_or(""));
                return true;
            }
            "started" => return true,
            "steering-accepted" => {
                self.prompt.push_str("\n补充要求：");
                self.prompt.push_str(event["text"].as_str().unwrap_or(""));
                self.clear_pending();
            }
            "approval-expired" | "approval-resolved" => {
                self.events.retain(|old| {
                    old["type"] != "approval" || old["approvalId"] != event["approvalId"]
                });
            }
            "action-resolved" => self.events.retain(|old| old["type"] != "action-proposed"),
            "workspace-resolved" => {
                self.events
                    .retain(|old| old["type"] != "workspace-required");
                if let Some(cwd) = event["cwd"].as_str() {
                    self.cwd = Some(cwd.into());
                }
            }
            "completed" | "failed" | "cancelled" => self.clear_pending(),
            _ => {}
        }
        // Keep the latest occurrence of each control event, but each tool and approval has its own ID.
        self.events.retain(|old| {
            if old["type"] != event["type"] {
                return true;
            }
            match kind {
                "tool-start" | "tool-end" => old["toolCallId"] != event["toolCallId"],
                "approval" | "approval-expired" | "approval-resolved" => {
                    old["approvalId"] != event["approvalId"]
                }
                _ => false,
            }
        });
        self.events.push(event.clone());
        // Step metadata remains in the task journal; a window needs only recent tool activity.
        let mut tools = VecDeque::new();
        for item in self.events.iter().rev() {
            if matches!(item["type"].as_str(), Some("tool-start" | "tool-end")) {
                if let Some(id) = item["toolCallId"].as_str() {
                    if !tools.contains(&id) {
                        tools.push_back(id);
                    }
                }
            }
        }
        let keep: Vec<String> = tools
            .into_iter()
            .take(RECENT_TOOLS)
            .map(String::from)
            .collect();
        self.events.retain(|item| {
            !matches!(item["type"].as_str(), Some("tool-start" | "tool-end"))
                || item["toolCallId"]
                    .as_str()
                    .is_some_and(|id| keep.iter().any(|saved| saved == id))
        });
        // Resolved approvals are status-only; do not retain their entire history.
        for kind in ["approval-resolved", "approval-expired"] {
            let last = self.events.iter().rposition(|item| item["type"] == kind);
            self.events = self
                .events
                .drain(..)
                .enumerate()
                .filter_map(|(index, item)| {
                    (item["type"] != kind || Some(index) == last).then_some(item)
                })
                .collect();
        }
        true
    }

    fn clear_pending(&mut self) {
        self.events.retain(|old| {
            !matches!(
                old["type"].as_str(),
                Some("approval" | "action-proposed" | "workspace-required")
            )
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot() -> TaskSnapshot {
        TaskSnapshot::new("task".into(), "conversation".into(), None, "hello".into())
    }
    fn record(snapshot: &mut TaskSnapshot, mut event: Value) -> Value {
        event["requestId"] = json!("task");
        assert!(snapshot.record(&mut event));
        event
    }

    #[test]
    fn coalesces_text_and_preserves_sequence_and_task_identity() {
        let mut state = snapshot();
        record(&mut state, json!({"type":"started"}));
        record(&mut state, json!({"type":"delta","text":"a"}));
        record(&mut state, json!({"type":"delta","text":"b"}));
        assert_eq!(state.response, "ab");
        assert_eq!(state.event_sequence, 3);
        assert!(state.events.is_empty());
        assert!(!state.record(&mut json!({"type":"delta","requestId":"old","text":"wrong"})));
        assert_eq!(state.response, "ab");
    }

    #[test]
    fn approvals_and_business_confirmations_do_not_resurrect_after_resolution() {
        let mut state = snapshot();
        record(&mut state, json!({"type":"approval","approvalId":"a"}));
        record(&mut state, json!({"type":"approval","approvalId":"b"}));
        record(
            &mut state,
            json!({"type":"approval-resolved","approvalId":"a"}),
        );
        record(
            &mut state,
            json!({"type":"action-proposed","draft":{"id":"draft"}}),
        );
        record(&mut state, json!({"type":"action-resolved"}));
        record(&mut state, json!({"type":"workspace-required"}));
        record(
            &mut state,
            json!({"type":"workspace-resolved","cwd":"/workspace"}),
        );
        assert_eq!(state.cwd.as_deref(), Some("/workspace"));
        assert!(!state
            .events
            .iter()
            .any(|e| e["type"] == "approval" && e["approvalId"] == "a"));
        assert!(state
            .events
            .iter()
            .any(|e| e["type"] == "approval" && e["approvalId"] == "b"));
        assert!(!state
            .events
            .iter()
            .any(|e| e["type"] == "action-proposed" || e["type"] == "workspace-required"));
    }

    #[test]
    fn terminal_is_final_and_clears_pending_ui_without_reexecuting_tools() {
        let mut state = snapshot();
        record(&mut state, json!({"type":"approval","approvalId":"a"}));
        record(&mut state, json!({"type":"completed"}));
        assert!(state.terminal());
        assert_eq!(state.events.len(), 1);
        assert!(!state.record(&mut json!({"type":"tool-start","requestId":"task"})));
    }

    #[test]
    fn keeps_recent_tool_pairs_and_latest_status_with_bounded_history() {
        let mut state = snapshot();
        for id in 0..100 {
            record(
                &mut state,
                json!({"type":"tool-start","toolCallId":id.to_string()}),
            );
            record(
                &mut state,
                json!({"type":"tool-end","toolCallId":id.to_string()}),
            );
        }
        assert_eq!(state.events.len(), RECENT_TOOLS * 2);
        assert!(!state.events.iter().any(|e| e["toolCallId"] == "0"));
        assert_eq!(state.events.last().unwrap()["eventSequence"], 200);
    }
}
