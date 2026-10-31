//! Task metadata only: never duplicate prompts, tool arguments, outputs or credentials.
//!
//! 04 §4.4：步骤上限 2048，超出滚动归档到 steps-archive/<任务 id>.json；
//! fsync 批量节流（500ms 或每 8 条），终态强制落盘。
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const STEPS_LIMIT: usize = 2048;
const ARCHIVE_CHUNK: usize = 1024;
const MILESTONE_LIMIT: usize = 256;
const NOTICE_LIMIT: usize = 32;
const FLUSH_INTERVAL: Duration = Duration::from_millis(500);
const FLUSH_BATCH: u32 = 8;

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
    #[serde(default)]
    pub milestones: Vec<TaskMilestone>,
    #[serde(default)]
    pub notices: Vec<TaskNotice>,
    #[serde(default)]
    pub usage: UsageTotals,
    #[serde(default)]
    pub receipt_status: Option<String>,
    /// P2 §9 崩溃自动续跑：该任务链（以链根记录为准）已经自动续跑过一次。
    #[serde(default)]
    pub auto_resumed: bool,
    /// P2 §9 契约痕迹：重启后识别"等待契约确认时被中断"的任务（配合快照 prompt 重新发起）。
    #[serde(default)]
    pub contract_pending: bool,
    #[serde(default)]
    pub contract_id: Option<String>,
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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskMilestone {
    pub id: String,
    pub status: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskNotice {
    pub level: String,
    pub text: String,
    pub at: u64,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub turns: u64,
}

/// 未落盘的累计变更，按 tasks.json 路径共享（多个 journal 实例看到同一份缓冲）。
#[derive(Default)]
struct PendingFlush {
    records: HashMap<String, TaskRecord>,
    since: Option<Instant>,
    count: u32,
}

static PENDING: std::sync::LazyLock<Mutex<HashMap<PathBuf, PendingFlush>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

pub struct TaskJournal {
    path: PathBuf,
    archive_dir: PathBuf,
}

fn terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled" | "interrupted")
}

fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

impl TaskJournal {
    /// Read-only view for consumers that must not alter terminal states.
    pub fn all(&self) -> Result<Vec<TaskRecord>, String> {
        self.flush_pending()?;
        crate::storage::read(&self.path)
    }
    pub fn delete_conversation(&self, id: &str) -> Result<(), String> {
        self.update(|records| {
            records.retain(|record| record.conversation_id != id);
            Ok(())
        })
    }

    pub fn new(agent_dir: &Path) -> Self {
        Self {
            path: agent_dir.join("tasks.json"),
            archive_dir: agent_dir.join("steps-archive"),
        }
    }

    fn update<T>(
        &self,
        change: impl FnOnce(&mut Vec<TaskRecord>) -> Result<T, String>,
    ) -> Result<T, String> {
        self.flush_pending()?;
        let _transaction = crate::storage::transaction();
        let mut records: Vec<TaskRecord> = crate::storage::read(&self.path)?;
        let result = change(&mut records)?;
        crate::storage::write(&self.path, &records)?;
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
                milestones: Vec::new(),
                notices: Vec::new(),
                usage: UsageTotals::default(),
                receipt_status: None,
                auto_resumed: false,
                contract_pending: false,
                contract_id: None,
            });
            // Keep recent records without discarding active tasks.
            if records.len() > 100 {
                let mut remove = records.len() - 100;
                records.retain(|record| {
                    if remove > 0 && terminal(&record.status) {
                        remove -= 1;
                        false
                    } else {
                        true
                    }
                });
            }
            Ok(())
        })
    }

    /// 目标记录的最新状态（共享缓冲优先，否则回读磁盘）。
    fn current_record(&self, request_id: &str) -> Result<TaskRecord, String> {
        {
            let map = PENDING.lock().map_err(|_| "任务记录状态不可用")?;
            if let Some(record) = map
                .get(&self.path)
                .and_then(|state| state.records.get(request_id))
            {
                return Ok(record.clone());
            }
        }
        let records: Vec<TaskRecord> = crate::storage::read(&self.path)?;
        records
            .iter()
            .find(|record| record.request_id == request_id)
            .cloned()
            .ok_or_else(|| "任务记录不存在".into())
    }

    /// 把未落盘记录合并回磁盘；非终态缓冲不得覆盖其他写入者已标记的终态。
    pub fn flush_pending(&self) -> Result<(), String> {
        let dirty = {
            let mut map = PENDING.lock().map_err(|_| "任务记录状态不可用")?;
            let Some(state) = map.get_mut(&self.path) else {
                return Ok(());
            };
            if state.records.is_empty() {
                map.remove(&self.path);
                return Ok(());
            }
            state.count = 0;
            state.since = None;
            std::mem::take(&mut state.records)
        };
        let _transaction = crate::storage::transaction();
        let mut records: Vec<TaskRecord> = crate::storage::read(&self.path)?;
        let mut changed = false;
        for (id, pending_record) in dirty {
            if let Some(record) = records.iter_mut().find(|record| record.request_id == id) {
                // Late flushes must never revive a task another writer marked terminal.
                if terminal(&record.status) && !terminal(&pending_record.status) {
                    continue;
                }
                *record = pending_record;
                changed = true;
            }
        }
        if changed {
            crate::storage::write(&self.path, &records)?;
        }
        Ok(())
    }

    fn due(count: u32, since: Option<Instant>) -> bool {
        count >= FLUSH_BATCH || since.is_some_and(|since| since.elapsed() >= FLUSH_INTERVAL)
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
                | "contract-proposed"
                | "milestone"
                | "notice"
                | "usage"
                | "receipt"
                | "completed"
                | "failed"
                | "cancelled"
        ) {
            return Ok(());
        }
        let mut record = self.current_record(request_id)?;
        // Late process events must never revive a terminal task.
        if terminal(&record.status) {
            return Ok(());
        }
        self.apply_event(&mut record, kind, event, now)?;
        let due = {
            let mut map = PENDING.lock().map_err(|_| "任务记录状态不可用")?;
            let state = map.entry(self.path.clone()).or_default();
            state.records.insert(request_id.to_string(), record);
            state.count = state.count.saturating_add(1);
            if state.since.is_none() {
                state.since = Some(Instant::now());
            }
            terminal(kind) || Self::due(state.count, state.since)
        };
        if due {
            self.flush_pending()?;
        }
        Ok(())
    }

    /// 就地应用一条事件；终态时把仍在运行的步骤标记为 unknown。
    fn apply_event(
        &self,
        record: &mut TaskRecord,
        kind: &str,
        event: &Value,
        now: u64,
    ) -> Result<(), String> {
        record.updated_at = now;
        record.status = match kind {
            "app-tool" | "approval" | "action-proposed" | "workspace-required"
            | "contract-proposed" => "waiting".into(),
            "completed" | "failed" | "cancelled" => kind.into(),
            "tool-start" | "tool-end" | "milestone" | "notice" => "running".into(),
            // usage/receipt 只累计数据，不改变运行状态。
            _ => record.status.clone(),
        };
        match kind {
            "tool-start" | "tool-end" => {
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
                    if record.steps.len() >= STEPS_LIMIT {
                        // 04 §4.4：滚动归档最老的一段，任务继续运行而不是被终止。
                        let overflow: Vec<TaskStep> = record.steps.drain(..ARCHIVE_CHUNK).collect();
                        self.archive_steps(&record.request_id, overflow)?;
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
            "milestone" => {
                let id = event["milestoneId"].as_str().unwrap_or("").to_string();
                let milestone_status = event["status"].as_str().unwrap_or("started").to_string();
                let title = event["title"].as_str().unwrap_or("").to_string();
                let note = event["note"].as_str().map(str::to_string);
                if let Some(milestone) = record
                    .milestones
                    .iter_mut()
                    .find(|milestone| milestone.id == id)
                {
                    milestone.status = milestone_status;
                    if !title.is_empty() {
                        milestone.title = title;
                    }
                    milestone.note = note;
                } else {
                    if record.milestones.len() >= MILESTONE_LIMIT {
                        return Err("任务里程碑数量超出记录上限".into());
                    }
                    record.milestones.push(TaskMilestone {
                        id,
                        status: milestone_status,
                        title,
                        note,
                    });
                }
            }
            "notice" => {
                record.notices.push(TaskNotice {
                    level: event["level"].as_str().unwrap_or("info").to_string(),
                    text: event["text"]
                        .as_str()
                        .unwrap_or("")
                        .chars()
                        .take(200)
                        .collect(),
                    at: now,
                });
                let excess = record.notices.len().saturating_sub(NOTICE_LIMIT);
                record.notices.drain(..excess);
            }
            "usage" => {
                record.usage.input_tokens = record
                    .usage
                    .input_tokens
                    .saturating_add(event["inputTokens"].as_u64().unwrap_or(0));
                record.usage.output_tokens = record
                    .usage
                    .output_tokens
                    .saturating_add(event["outputTokens"].as_u64().unwrap_or(0));
                record.usage.turns = record.usage.turns.saturating_add(1);
            }
            "receipt" => {
                record.receipt_status = event["status"].as_str().map(str::to_string);
            }
            "contract-proposed" => {
                record.contract_pending = true;
                record.contract_id = event["contractId"].as_str().map(str::to_string);
            }
            "completed" | "failed" | "cancelled" => record.contract_pending = false,
            _ => {}
        }
        if terminal(&record.status) {
            for step in &mut record.steps {
                if step.status == "running" {
                    step.status = "unknown".into();
                }
            }
        }
        Ok(())
    }

    /// P2 §9 崩溃自动续跑：查询任务链根记录的自动续跑标记。
    /// 记录不存在（被淘汰或损坏）时按“已使用”处理，保守放弃续跑。
    pub fn auto_resume_used(&self, request_id: &str) -> bool {
        self.current_record(request_id)
            .map(|record| record.auto_resumed)
            .unwrap_or(true)
    }

    /// P2 §9 崩溃自动续跑：占用链根记录的标记；先于续跑启动执行，防循环。
    /// 终态守卫不适用（链根记录在崩溃后通常已是 failed）。
    pub fn mark_auto_resumed(&self, request_id: &str) -> Result<(), String> {
        self.update(|records| {
            let record = records
                .iter_mut()
                .find(|record| record.request_id == request_id)
                .ok_or("任务记录不存在，无法标记自动续跑")?;
            record.auto_resumed = true;
            Ok(())
        })
    }

    /// 超出常驻上限的步骤滚动归档到 steps-archive/<任务 id>.json（原子写复用 storage）。
    fn archive_steps(&self, request_id: &str, steps: Vec<TaskStep>) -> Result<(), String> {
        if steps.is_empty() {
            return Ok(());
        }
        if !safe_id(request_id) {
            return Err("任务标识无法归档步骤".into());
        }
        std::fs::create_dir_all(&self.archive_dir).map_err(|e| e.to_string())?;
        let path = self.archive_dir.join(format!("{request_id}.json"));
        let mut archived: Vec<TaskStep> = if path.exists() {
            crate::storage::read(&path)?
        } else {
            Vec::new()
        };
        archived.extend(steps);
        crate::storage::write(&path, &archived)
    }

    #[cfg(test)]
    pub fn recover(&self, active_id: Option<&str>, now: u64) -> Result<Vec<TaskRecord>, String> {
        self.recover_active(&active_id.into_iter().collect::<Vec<_>>(), now)
    }

    pub fn recover_active(&self, active_ids: &[&str], now: u64) -> Result<Vec<TaskRecord>, String> {
        self.flush_pending()?;
        let _transaction = crate::storage::transaction();
        let mut records: Vec<TaskRecord> = crate::storage::read(&self.path)?;
        let mut changed = false;
        for record in &mut records {
            if !terminal(&record.status) && !active_ids.contains(&record.request_id.as_str()) {
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
            crate::storage::write(&self.path, &records)?;
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
    fn deleting_conversation_is_persistent_and_preserves_other_tasks() {
        let directory = tempfile::tempdir().unwrap();
        let journal = TaskJournal::new(directory.path());
        journal.start("r1", "delete-me", 1).unwrap();
        journal.start("r2", "keep-me", 2).unwrap();
        journal.delete_conversation("delete-me").unwrap();
        let records = TaskJournal::new(directory.path()).all().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].conversation_id, "keep-me");
    }

    #[test]
    fn recovery_preserves_every_live_task_and_only_interrupts_orphans() {
        let dir = tempfile::tempdir().unwrap();
        let journal = TaskJournal::new(dir.path());
        journal.start("r1", "c1", 1).unwrap();
        journal.start("r2", "c2", 2).unwrap();
        journal.start("orphan", "c3", 3).unwrap();
        let records = journal.recover_active(&["r1", "r2"], 4).unwrap();
        for id in ["r1", "r2"] {
            assert_eq!(
                records
                    .iter()
                    .find(|record| record.request_id == id)
                    .unwrap()
                    .status,
                "running"
            );
        }
        assert_eq!(
            records
                .iter()
                .find(|record| record.request_id == "orphan")
                .unwrap()
                .status,
            "interrupted"
        );
        journal
            .event("r1", &json!({"type":"completed"}), 5)
            .unwrap();
        let records = journal.recover_active(&["r2"], 6).unwrap();
        assert_eq!(
            records
                .iter()
                .find(|record| record.request_id == "r2")
                .unwrap()
                .status,
            "running"
        );
    }

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

    #[test]
    fn events_are_batched_before_hitting_disk_but_stay_visible_to_reads() {
        let directory = tempfile::tempdir().unwrap();
        let journal = TaskJournal::new(directory.path());
        journal.start("request", "conversation", 1).unwrap();
        for index in 0..(FLUSH_BATCH as u64 - 1) {
            journal
                .event(
                    "request",
                    &json!({"type":"tool-start", "toolCallId":format!("t-{index}"), "tool":"read"}),
                    2 + index,
                )
                .unwrap();
        }
        // 节流中的事件不触发落盘（fsync 批量节流），但读取视图必须包含它们。
        let on_disk: Vec<TaskRecord> =
            serde_json::from_slice(&std::fs::read(directory.path().join("tasks.json")).unwrap())
                .unwrap();
        assert!(on_disk[0].steps.is_empty());
        assert_eq!(journal.current_record("request").unwrap().steps.len(), 7);
        let records = TaskJournal::new(directory.path()).all().unwrap();
        assert_eq!(records[0].steps.len(), 7);
        // 读取触发落盘后计数清零，再次单条事件保持缓冲，显式 flush 才落盘。
        journal
            .event(
                "request",
                &json!({"type":"tool-start", "toolCallId":"t-final", "tool":"read"}),
                9,
            )
            .unwrap();
        let on_disk: Vec<TaskRecord> =
            serde_json::from_slice(&std::fs::read(directory.path().join("tasks.json")).unwrap())
                .unwrap();
        assert_eq!(on_disk[0].steps.len(), 7);
        journal.flush_pending().unwrap();
        let on_disk: Vec<TaskRecord> =
            serde_json::from_slice(&std::fs::read(directory.path().join("tasks.json")).unwrap())
                .unwrap();
        assert_eq!(on_disk[0].steps.len(), 8);
    }

    #[test]
    fn the_batch_limit_forces_a_flush_without_any_reader() {
        let directory = tempfile::tempdir().unwrap();
        let journal = TaskJournal::new(directory.path());
        journal.start("request", "conversation", 1).unwrap();
        for index in 0..FLUSH_BATCH as u64 {
            journal
                .event(
                    "request",
                    &json!({"type":"tool-start", "toolCallId":format!("t-{index}"), "tool":"read"}),
                    2 + index,
                )
                .unwrap();
        }
        let on_disk: Vec<TaskRecord> =
            serde_json::from_slice(&std::fs::read(directory.path().join("tasks.json")).unwrap())
                .unwrap();
        assert_eq!(on_disk[0].steps.len(), FLUSH_BATCH as usize);
    }

    #[test]
    fn terminal_events_are_flushed_immediately_and_late_events_cannot_revive() {
        let directory = tempfile::tempdir().unwrap();
        let journal = TaskJournal::new(directory.path());
        journal.start("request", "conversation", 1).unwrap();
        journal
            .event(
                "request",
                &json!({"type":"tool-start", "toolCallId":"t-1", "tool":"bash"}),
                2,
            )
            .unwrap();
        journal
            .event("request", &json!({"type":"failed"}), 3)
            .unwrap();
        let on_disk: Vec<TaskRecord> =
            serde_json::from_slice(&std::fs::read(directory.path().join("tasks.json")).unwrap())
                .unwrap();
        assert_eq!(on_disk[0].status, "failed");
        assert_eq!(on_disk[0].steps[0].status, "unknown");
        journal
            .event(
                "request",
                &json!({"type":"tool-end", "toolCallId":"t-1", "tool":"bash"}),
                4,
            )
            .unwrap();
        let on_disk: Vec<TaskRecord> =
            serde_json::from_slice(&std::fs::read(directory.path().join("tasks.json")).unwrap())
                .unwrap();
        assert_eq!(on_disk[0].status, "failed");
    }

    #[test]
    fn steps_beyond_limit_roll_into_the_archive_and_the_task_survives() {
        // 高频落盘压测与 data_snapshot 的 freeze 竞争读租约，串行执行避免饿死。
        let _serial = crate::data_gate::TEST_FREEZE
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let directory = tempfile::tempdir().unwrap();
        let journal = TaskJournal::new(directory.path());
        journal.start("request", "conversation", 1).unwrap();
        let total = 2200u64;
        for index in 0..total {
            journal
                .event(
                    "request",
                    &json!({"type":"tool-start", "toolCallId":format!("step-{index}"), "tool":"read"}),
                    index + 2,
                )
                .unwrap();
        }
        let record = journal.current_record("request").unwrap();
        assert!(record.steps.len() < STEPS_LIMIT);
        assert!(record.steps.len() >= STEPS_LIMIT - ARCHIVE_CHUNK);
        let archived: Vec<TaskStep> =
            crate::storage::read(&directory.path().join("steps-archive").join("request.json"))
                .unwrap();
        assert_eq!(record.steps.len() + archived.len(), total as usize);
        assert_eq!(archived[0].id, "step-0");
        journal
            .event("request", &json!({"type":"completed"}), 9_999)
            .unwrap();
        let records = TaskJournal::new(directory.path())
            .recover(None, 10_000)
            .unwrap();
        assert_eq!(records[0].status, "completed");
    }

    #[test]
    fn milestones_notices_usage_and_receipt_are_recoverable() {
        let directory = tempfile::tempdir().unwrap();
        let journal = TaskJournal::new(directory.path());
        journal.start("request", "conversation", 1).unwrap();
        journal
            .event(
                "request",
                &json!({"type":"milestone", "milestoneId":"m1", "status":"started", "title":"搭建骨架"}),
                2,
            )
            .unwrap();
        journal
            .event(
                "request",
                &json!({"type":"notice", "level":"warn", "text":"安装了依赖"}),
                3,
            )
            .unwrap();
        journal
            .event(
                "request",
                &json!({"type":"usage", "inputTokens":120, "outputTokens":45}),
                4,
            )
            .unwrap();
        journal
            .event(
                "request",
                &json!({"type":"milestone", "milestoneId":"m1", "status":"completed"}),
                5,
            )
            .unwrap();
        journal
            .event(
                "request",
                &json!({"type":"receipt", "status":"completed"}),
                6,
            )
            .unwrap();
        // 超出容量的黄旗滚动丢弃，里程碑保持可恢复展示。
        for index in 0..40 {
            journal
                .event(
                    "request",
                    &json!({"type":"notice", "level":"info", "text":format!("flag-{index}")}),
                    6 + index,
                )
                .unwrap();
        }
        let record = journal.current_record("request").unwrap();
        assert_eq!(record.milestones.len(), 1);
        assert_eq!(record.milestones[0].status, "completed");
        assert_eq!(record.milestones[0].title, "搭建骨架");
        assert_eq!(record.receipt_status.as_deref(), Some("completed"));
        assert_eq!(record.usage.input_tokens, 120);
        assert_eq!(record.usage.output_tokens, 45);
        assert_eq!(record.usage.turns, 1);
        assert_eq!(record.notices.len(), NOTICE_LIMIT);
        assert_eq!(record.notices.last().unwrap().text, "flag-39");
        let records = TaskJournal::new(directory.path())
            .recover(None, 99)
            .unwrap();
        assert_eq!(records[0].milestones, record.milestones);
        assert_eq!(records[0].usage, record.usage);
    }

    #[test]
    fn contract_waits_mark_the_task_as_waiting() {
        let directory = tempfile::tempdir().unwrap();
        let journal = TaskJournal::new(directory.path());
        journal.start("request", "conversation", 1).unwrap();
        journal
            .event(
                "request",
                &json!({"type":"contract-proposed", "contractId":"c-1"}),
                2,
            )
            .unwrap();
        assert_eq!(journal.current_record("request").unwrap().status, "waiting");
        journal
            .event(
                "request",
                &json!({"type":"milestone", "milestoneId":"m1", "status":"started"}),
                3,
            )
            .unwrap();
        assert_eq!(journal.current_record("request").unwrap().status, "running");
    }

    #[test]
    fn auto_resume_flag_is_durable_and_missing_records_count_as_used() {
        // P2 §9：链根记录的自动续跑标记——同一任务链最多自动续跑一次的权威依据。
        let directory = tempfile::tempdir().unwrap();
        let journal = TaskJournal::new(directory.path());
        journal.start("root", "conversation", 1).unwrap();
        assert!(!journal.auto_resume_used("root"));
        journal.mark_auto_resumed("root").unwrap();
        assert!(journal.auto_resume_used("root"));
        // 崩溃后的链根通常已是终态；终态记录同样可以占用标记。
        journal.event("root", &json!({"type":"failed"}), 2).unwrap();
        let reopened = TaskJournal::new(directory.path());
        assert!(reopened.auto_resume_used("root"));
        // 记录不存在（被淘汰）时保守按“已使用”处理，防循环优先于续跑成功率。
        assert!(reopened.auto_resume_used("missing"));
        assert!(reopened.mark_auto_resumed("missing").is_err());
    }

    #[test]
    fn a_flush_never_revives_a_record_cancelled_by_another_writer() {
        let directory = tempfile::tempdir().unwrap();
        let journal = TaskJournal::new(directory.path());
        journal.start("request", "conversation", 1).unwrap();
        journal
            .event(
                "request",
                &json!({"type":"tool-start", "toolCallId":"t-1", "tool":"bash"}),
                2,
            )
            .unwrap();
        // 另一个实例（取消看门狗）写入 cancelled 时共享缓冲一并落盘，运行中的步骤标记 unknown。
        let watchdog = TaskJournal::new(directory.path());
        watchdog
            .event("request", &json!({"type":"cancelled"}), 3)
            .unwrap();
        let on_disk: Vec<TaskRecord> =
            serde_json::from_slice(&std::fs::read(directory.path().join("tasks.json")).unwrap())
                .unwrap();
        assert_eq!(on_disk[0].status, "cancelled");
        assert_eq!(on_disk[0].steps[0].status, "unknown");
        // 第一个实例稍后落盘不得复活 cancelled。
        journal.flush_pending().unwrap();
        let on_disk: Vec<TaskRecord> =
            serde_json::from_slice(&std::fs::read(directory.path().join("tasks.json")).unwrap())
                .unwrap();
        assert_eq!(on_disk[0].status, "cancelled");
    }
}
