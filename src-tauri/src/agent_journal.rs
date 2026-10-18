//! Task metadata only: never duplicate prompts, tool arguments, outputs or credentials.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    pub request_id: String,
    pub conversation_id: String,
    pub status: String,
    pub started_at: u64,
    pub updated_at: u64,
    pub steps: Vec<TaskStep>,
    #[serde(default)]
    pub resume_of: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskStep {
    pub id: String,
    pub tool: String,
    pub status: String,
    #[serde(default)]
    pub verification: Option<String>,
}

pub struct TaskJournal(PathBuf);

fn terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled" | "interrupted")
}

impl TaskJournal {
    /// Read-only view for consumers that must not alter terminal states.
    pub fn all(&self) -> Result<Vec<TaskRecord>, String> {
        crate::storage::read(&self.0)
    }
    pub fn new(agent_dir: &Path) -> Self {
        Self(agent_dir.join("tasks.json"))
    }

    fn update<T>(
        &self,
        change: impl FnOnce(&mut Vec<TaskRecord>) -> Result<T, String>,
    ) -> Result<T, String> {
        let _transaction = crate::storage::transaction();
        let mut records: Vec<TaskRecord> = crate::storage::read(&self.0)?;
        let result = change(&mut records)?;
        crate::storage::write(&self.0, &records)?;
        Ok(result)
    }

    #[cfg(test)]
    pub fn start(&self, request_id: &str, conversation_id: &str, now: u64) -> Result<(), String> {
        self.start_linked(request_id, conversation_id, now, None)
    }
    pub fn start_linked(
        &self,
        request_id: &str,
        conversation_id: &str,
        now: u64,
        resume_of: Option<String>,
    ) -> Result<(), String> {
        self.update(|records| {
            if records.iter().any(|record| record.request_id == request_id) {
                return Err("该任务标识已使用，请新建请求，避免重复执行".into());
            }
            records.push(TaskRecord {
                request_id: request_id.into(),
                conversation_id: conversation_id.into(),
                status: "running".into(),
                started_at: now,
                updated_at: now,
                steps: Vec::new(),
                resume_of,
            });
            // The runtime allows one active task. Keep the newest 100 records.
            if records.len() > 100 {
                records.drain(..records.len() - 100);
            }
            Ok(())
        })
    }

    pub fn event(&self, request_id: &str, event: &Value, now: u64) -> Result<(), String> {
        let kind = event["type"].as_str().unwrap_or("");
        if !matches!(
            kind,
            "tool-start"
                | "tool-end"
                | "app-tool"
                | "approval"
                | "approval-expired"
                | "action-proposed"
                | "workspace-required"
                | "completed"
                | "failed"
                | "cancelled"
        ) {
            return Ok(());
        }
        self.update(|records| {
            let record = records
                .iter_mut()
                .find(|record| record.request_id == request_id)
                .ok_or("任务记录不存在")?;
            // Late process events must never revive a terminal task.
            if terminal(&record.status) {
                return Ok(());
            }
            record.updated_at = now;
            record.status = match kind {
                "app-tool" | "approval" | "action-proposed" | "workspace-required" => "waiting",
                "completed" | "failed" | "cancelled" => kind,
                _ => "running",
            }
            .into();
            if matches!(kind, "tool-start" | "tool-end") {
                let id = event["toolCallId"].as_str().unwrap_or("");
                let status = if kind == "tool-start" {
                    "running"
                } else if event["isError"].as_bool() == Some(true) {
                    "failed"
                } else {
                    "completed"
                };
                if let Some(step) = record.steps.iter_mut().find(|step| step.id == id) {
                    step.status = status.into();
                    step.verification = event["verification"]["state"].as_str().map(str::to_string);
                } else {
                    if record.steps.len() >= 256 {
                        return Err("任务步骤已达记录上限，已停止以保留可核对的记录".into());
                    }
                    record.steps.push(TaskStep {
                        id: id.chars().take(200).collect(),
                        tool: event["tool"]
                            .as_str()
                            .unwrap_or("工具")
                            .chars()
                            .take(100)
                            .collect(),
                        status: status.into(),
                        verification: event["verification"]["state"].as_str().map(str::to_string),
                    });
                }
            }
            if terminal(&record.status) {
                for step in &mut record.steps {
                    if step.status == "running" {
                        step.status = "unknown".into();
                    }
                }
            }
            Ok(())
        })
    }

    pub fn recover(&self, active_id: Option<&str>, now: u64) -> Result<Vec<TaskRecord>, String> {
        let _transaction = crate::storage::transaction();
        let mut records: Vec<TaskRecord> = crate::storage::read(&self.0)?;
        let mut changed = false;
        for record in &mut records {
            if !terminal(&record.status) && active_id != Some(record.request_id.as_str()) {
                record.status = "interrupted".into();
                record.updated_at = now;
                for step in &mut record.steps {
                    if step.status == "running" {
                        step.status = "unknown".into();
                    }
                }
                changed = true;
            }
        }
        if changed {
            crate::storage::write(&self.0, &records)?;
        }
        records.reverse();
        Ok(records)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn restart_preserves_finished_steps_and_marks_pending_work_unknown() {
        let directory = tempfile::tempdir().unwrap();
        let journal = TaskJournal::new(directory.path());
        journal.start("request-1", "conversation-1", 1).unwrap();
        journal
            .event(
                "request-1",
                &json!({"type":"tool-start", "toolCallId":"read-1", "tool":"read"}),
                2,
            )
            .unwrap();
        journal
            .event(
                "request-1",
                &json!({"type":"tool-end", "toolCallId":"read-1", "tool":"read", "isError":false}),
                3,
            )
            .unwrap();
        journal
            .event(
                "request-1",
                &json!({"type":"tool-start", "toolCallId":"write-1", "tool":"write"}),
                4,
            )
            .unwrap();
        journal
            .event("request-1", &json!({"type":"approval"}), 5)
            .unwrap();
        let active = journal.recover(Some("request-1"), 6).unwrap();
        assert_eq!(active[0].status, "waiting");
        let reopened = TaskJournal::new(directory.path());
        let recovered = reopened.recover(None, 7).unwrap();
        assert_eq!(recovered[0].status, "interrupted");
        assert_eq!(recovered[0].steps[0].status, "completed");
        assert_eq!(recovered[0].steps[1].status, "unknown");
        assert_eq!(reopened.recover(None, 8).unwrap(), recovered);
        // A late event cannot turn interruption into success.
        reopened
            .event("request-1", &json!({"type":"completed"}), 9)
            .unwrap();
        assert_eq!(reopened.recover(None, 10).unwrap(), recovered);
    }

    #[test]
    fn terminal_states_survive_restart_without_replay_or_duplicate_ids() {
        let directory = tempfile::tempdir().unwrap();
        let journal = TaskJournal::new(directory.path());
        for (index, status) in ["completed", "failed", "cancelled"].iter().enumerate() {
            let id = format!("request-{index}");
            journal.start(&id, "conversation", 1).unwrap();
            journal.event(&id, &json!({"type":status}), 2).unwrap();
            assert!(journal.start(&id, "conversation", 3).is_err());
        }
        let records = TaskJournal::new(directory.path()).recover(None, 4).unwrap();
        assert_eq!(
            records
                .iter()
                .map(|record| record.status.as_str())
                .collect::<Vec<_>>(),
            ["cancelled", "failed", "completed"]
        );
    }

    #[test]
    fn task_metadata_does_not_duplicate_sensitive_arguments_or_outputs() {
        let directory = tempfile::tempdir().unwrap();
        let journal = TaskJournal::new(directory.path());
        journal.start("request", "conversation", 1).unwrap();
        journal.event("request", &json!({"type":"tool-start", "toolCallId":"call", "tool":"bash", "arguments":{"command":"SECRET_MARKER"}}), 2).unwrap();
        journal.event("request", &json!({"type":"tool-end", "toolCallId":"call", "tool":"bash", "output":"PRIVATE_OUTPUT", "isError":true}), 3).unwrap();
        let raw = std::fs::read_to_string(directory.path().join("tasks.json")).unwrap();
        assert!(!raw.contains("SECRET_MARKER"));
        assert!(!raw.contains("PRIVATE_OUTPUT"));
        assert_eq!(
            journal.recover(Some("request"), 4).unwrap()[0].steps[0].status,
            "failed"
        );
    }

    #[test]
    fn corrupt_journal_blocks_new_tasks_without_overwriting_evidence() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tasks.json");
        std::fs::write(&path, "corrupt").unwrap();
        let journal = TaskJournal::new(directory.path());
        assert!(journal.recover(None, 1).is_err());
        assert!(journal.start("request", "conversation", 2).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "corrupt");
    }
}
