//! S09 proactive sources: task-unresolved reminders and start/return greetings.
//! Reminder identity is the task root id — retries of the same task chain can
//! never earn a second notice, and cancelled/completed tasks never remind.
use super::{model, proactive, store};
use rusqlite::{params, Connection, OptionalExtension};
use tauri::{AppHandle, Manager};

// journal 模块挂在 crate::agent 下（#[path] 引入）。
use crate::agent::journal::{TaskJournal, TaskRecord};

const DAY: i64 = 86_400;
const NINE_AM_LOCAL: i64 = 9 * 3_600;
const GREETING_WINDOW: i64 = 30 * 60;

fn next_nine_am_local(unix: i64, offset: i64) -> i64 {
    let local = unix + offset;
    let day = local.div_euclid(DAY);
    (day + 1) * DAY + NINE_AM_LOCAL - offset
}

/// Follow the retries chain (`resume_of`) back to the task that first ran.
fn root_of(records: &[TaskRecord], request_id: &str) -> String {
    let mut current = request_id.to_string();
    for _ in 0..records.len() {
        let Some(record) = records.iter().find(|record| record.request_id == current) else {
            break;
        };
        match record.resume_of.as_deref() {
            Some(parent) if !parent.is_empty() && parent != current => current = parent.to_string(),
            _ => break,
        }
    }
    current
}

pub(crate) fn task_candidate(
    records: &[TaskRecord],
    request_id: &str,
    offset: i64,
) -> Option<model::ProactiveMessage> {
    let record = records
        .iter()
        .find(|record| record.request_id == request_id)?;
    let root = root_of(records, request_id);
    let status = record.status.as_str();
    if status != "failed" && status != "interrupted" {
        // completed/cancelled tasks and live tasks never remind.
        return None;
    }
    let template_id = if status == "failed" {
        "task_failed"
    } else {
        "task_interrupted"
    };
    let valid_from = next_nine_am_local(i64::try_from(record.updated_at).unwrap_or(0), offset);
    Some(model::ProactiveMessage {
        id: format!("task-remind-{root}"),
        category: model::ProactiveCategory::TaskUnresolved,
        source: model::SourceRef {
            kind: "agent_task".into(),
            id: root.clone(),
            revision: 1,
        },
        // One identity per task: retries changed resume chains still land on
        // the same root and share this dedupe key.
        dedupe_key: format!("task:{root}"),
        template_id: template_id.into(),
        valid_from,
        expires_at: valid_from + model::ProactiveCategory::TaskUnresolved.window_seconds(),
        state: model::DeliveryState::Pending,
    })
}

#[cfg(test)]
pub fn queue_task_reminder(
    conn: &mut Connection,
    records: &[TaskRecord],
    request_id: &str,
    offset: i64,
    now: i64,
) -> Result<(), String> {
    queue_task_reminder_at(conn, records, request_id, offset, now, None)
}

fn queue_task_reminder_local(
    conn: &mut Connection,
    records: &[TaskRecord],
    request_id: &str,
    offset: i64,
    now: i64,
) -> Result<(), String> {
    let due = records
        .iter()
        .find(|record| record.request_id == request_id)
        .and_then(|record| i64::try_from(record.updated_at).ok())
        .and_then(|unix| next_nine_in_zone(unix, &chrono::Local));
    if due.is_none() {
        return Err("invalid_task_time".into());
    }
    queue_task_reminder_at(conn, records, request_id, offset, now, due)
}

fn queue_task_reminder_at(
    conn: &mut Connection,
    records: &[TaskRecord],
    request_id: &str,
    offset: i64,
    now: i64,
    due: Option<i64>,
) -> Result<(), String> {
    let Some(record) = records
        .iter()
        .find(|record| record.request_id == request_id)
    else {
        return Ok(());
    };
    store::transaction(conn, |tx| {
        let computed = root_of(records, request_id);
        let root = record
            .resume_of
            .as_ref()
            .and_then(|parent| {
                tx.query_row(
                    "SELECT root_id FROM soul_task_links WHERE task_id=?1",
                    [parent],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .ok()
                .flatten()
            })
            .unwrap_or(computed);
        tx.execute(
            "INSERT INTO soul_task_links VALUES(?1,?2) ON CONFLICT(task_id) DO NOTHING",
            params![request_id, root],
        )
        .map_err(|_| "ledger_write_failed")?;
        if matches!(record.status.as_str(), "completed" | "cancelled") {
            tx.execute(
                "UPDATE soul_task_followups SET state='resolved',updated_at=?2 WHERE root_id=?1",
                params![root, now],
            )
            .map_err(|_| "ledger_write_failed")?;
            tx.execute("UPDATE soul_proactive_ledger SET state='revoked',receipt_at=?2 WHERE dedupe_key=?1 AND state IN ('pending','dispatching','shown')",params![format!("task:{root}"),now]).map_err(|_| "ledger_write_failed")?;
            return Ok(());
        }
        let Some(mut candidate) = task_candidate(records, request_id, offset) else {
            return Ok(());
        };
        if let Some(due) = due {
            let window = candidate.expires_at - candidate.valid_from;
            candidate.valid_from = due;
            candidate.expires_at = due + window;
        }
        let resolved = tx
            .query_row(
                "SELECT state='resolved' FROM soul_task_followups WHERE root_id=?1",
                [&root],
                |r| r.get::<_, bool>(0),
            )
            .optional()
            .map_err(|_| "ledger_unreadable")?
            .unwrap_or(false);
        if resolved {
            return Ok(());
        }
        tx.execute("INSERT INTO soul_task_followups(root_id,task_id,state,updated_at) VALUES(?1,?2,'needs_check',?3) ON CONFLICT(root_id) DO UPDATE SET task_id=excluded.task_id,updated_at=excluded.updated_at",params![root,request_id,now]).map_err(|_| "ledger_write_failed")?;
        let baseline=tx.query_row("SELECT max(value) FROM (SELECT coalesce(enabled_since,0) AS value FROM soul_control UNION ALL SELECT cleared_through FROM soul_domain_baselines WHERE domain='proactive')",[],|r|r.get::<_,Option<i64>>(0)).map_err(|_| "ledger_unreadable")?.unwrap_or(0);
        if i64::try_from(record.updated_at).unwrap_or(0) < baseline || candidate.expires_at <= now {
            return Ok(());
        };
        if !proactive::event_allowed(
            tx,
            model::ProactiveCategory::TaskUnresolved,
            i64::try_from(record.updated_at).unwrap_or(0),
        )? {
            return Ok(());
        }
        candidate.id = format!("task-remind-{root}");
        candidate.dedupe_key = format!("task:{root}");
        candidate.source.id = root;
        proactive::queue(tx, candidate, now)
    })
}

pub(crate) fn greeting_candidate(event_id: &str, now: i64) -> model::ProactiveMessage {
    let event_id = event_id.to_string();
    model::ProactiveMessage {
        id: format!("greeting-{event_id}"),
        category: model::ProactiveCategory::Greeting,
        source: model::SourceRef {
            kind: "boot_event".into(),
            id: event_id.clone(),
            revision: 1,
        },
        dedupe_key: format!("greet:{event_id}"),
        template_id: "greeting".into(),
        valid_from: now,
        expires_at: now + GREETING_WINDOW,
        state: model::DeliveryState::Pending,
    }
}

pub fn queue_greeting(conn: &mut Connection, event_id: &str, now: i64) -> Result<(), String> {
    store::transaction(conn, |tx| {
        if !proactive::event_allowed(tx, model::ProactiveCategory::Greeting, now)? {
            return Ok(());
        }
        proactive::queue(tx, greeting_candidate(event_id, now), now)
    })
}

fn reminder_candidates_offset(unix: i64) -> i64 {
    reminder_offset_in_zone(unix, &chrono::Local).unwrap_or(0)
}

fn reminder_offset_in_zone<T: chrono::TimeZone>(unix: i64, zone: &T) -> Option<i64> {
    use chrono::Offset;
    let target = zone
        .timestamp_opt(next_nine_in_zone(unix, zone)?, 0)
        .single()?;
    Some(i64::from(target.offset().fix().local_minus_utc()))
}

fn next_nine_in_zone<T: chrono::TimeZone>(unix: i64, zone: &T) -> Option<i64> {
    let source = zone.timestamp_opt(unix, 0).single()?;
    let next = source.date_naive().succ_opt()?.and_hms_opt(9, 0, 0)?;
    Some(zone.from_local_datetime(&next).earliest()?.timestamp())
}

/// Boot source: recovery marks interrupted tasks (next act: read-only check)
/// and queues the start greeting. Delivery stays behind the category gates.
pub fn on_boot(app: &AppHandle) {
    let handle = app.clone();
    crate::background::SUPERVISOR.spawn_effect("soul-task-recovery", move |worker| {
        if worker.cancelled() {
            return;
        }
        let _lease = crate::data_gate::read();
        if !handle
            .try_state::<model::SoulBootStatus>()
            .is_some_and(|status| status.0)
        {
            return;
        }
        let Ok(base) = handle.path().app_data_dir() else {
            return;
        };
        let now = crate::common::unix_timestamp();
        let journal = TaskJournal::new(&base.join("agent"));
        if let Ok(records) = handle
            .state::<crate::agent::AgentRuntime>()
            .recover_tasks(&journal, now)
        {
            let db = handle.state::<std::sync::Arc<crate::memory::MemoryDb>>();
            for record in &records {
                let mut conn = match db.0.lock() {
                    Ok(inner) => inner,
                    Err(_) => return,
                };
                let _ = queue_task_reminder_local(
                    &mut conn,
                    &records,
                    &record.request_id,
                    reminder_candidates_offset(i64::try_from(record.updated_at).unwrap_or(0)),
                    i64::try_from(now).unwrap_or(0),
                );
            }
        }
        let event_id = format!(
            "boot-{}-{}",
            crate::common::unix_timestamp(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        );
        let db = handle.state::<std::sync::Arc<crate::memory::MemoryDb>>();
        let mut conn = match db.0.lock() {
            Ok(inner) => inner,
            Err(_) => return,
        };
        let _ = queue_greeting(&mut conn, &event_id, i64::try_from(now).unwrap_or(0));
        drop(conn);
    });
}

/// Terminal source: a just-finished task may enter the next-morning reminder
/// queue (failed → check the record; interrupted → read-only check next run).
pub fn on_task_terminal(app: &AppHandle, request_id: &str) {
    let handle = app.clone();
    let request_id = request_id.to_string();
    crate::background::SUPERVISOR.spawn_effect("soul-task-outcome", move |worker| {
        if worker.cancelled() {
            return;
        }
        let _lease = crate::data_gate::read();
        if !handle
            .try_state::<model::SoulBootStatus>()
            .is_some_and(|status| status.0)
        {
            return;
        }
        let Ok(base) = handle.path().app_data_dir() else {
            return;
        };
        let Ok(records) = TaskJournal::new(&base.join("agent")).all() else {
            return;
        };
        let db = handle.state::<std::sync::Arc<crate::memory::MemoryDb>>();
        let Ok(mut conn) = db.0.lock() else {
            return;
        };
        if let Some(record) = records
            .iter()
            .find(|record| record.request_id == request_id)
        {
            let kind = match record.status.as_str() {
                "completed" => Some("task_success"),
                "failed" => Some("task_failure"),
                "interrupted" => Some("task_interrupted"),
                _ => None,
            };
            if let Some(kind) = kind {
                let source = model::SourceRef {
                    kind: "agent_task".into(),
                    id: request_id.clone(),
                    revision: 1,
                };
                let _ = super::mood::event(
                    &mut conn,
                    kind,
                    &source,
                    record.updated_at as i64,
                    crate::common::unix_timestamp() as i64,
                );
                if record.status == "completed" {
                    let _ = super::continuity::record_event(
                        &mut conn,
                        "task_completed",
                        &source,
                        record.updated_at as i64,
                        crate::common::unix_timestamp() as i64,
                    );
                }
            }
        }
        let _ = queue_task_reminder_local(
            &mut conn,
            &records,
            &request_id,
            reminder_candidates_offset(
                records
                    .iter()
                    .find(|r| r.request_id == request_id)
                    .and_then(|r| i64::try_from(r.updated_at).ok())
                    .unwrap_or(0),
            ),
            i64::try_from(crate::common::unix_timestamp()).unwrap_or(0),
        );
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(request_id: &str, status: &str, updated_at: u64) -> TaskRecord {
        TaskRecord {
            request_id: request_id.into(),
            conversation_id: "c".into(),
            status: status.into(),
            started_at: updated_at - 10,
            updated_at,
            steps: Vec::new(),
            resume_of: None,
        }
    }

    #[test]
    fn next_nine_am_is_local_and_strictly_future() {
        // Monday 1970-01-05 08:00 local (offset +8h): today's local 09:00 is
        // 01:00 UTC; at 10:00 local the next local morning qualifies.
        assert_eq!(next_nine_am_local(0, 28_800), DAY + 3_600);
        assert_eq!(next_nine_am_local(10 * 3_600, 28_800), DAY + 3_600);
    }

    #[test]
    fn terminal_status_selects_template_and_next_day_window() {
        let failed = task_candidate(&[record("t1", "failed", 100)], "t1", 28_800).unwrap();
        assert_eq!(failed.template_id, "task_failed");
        assert_eq!(failed.dedupe_key, "task:t1");
        let interrupted =
            task_candidate(&[record("t2", "interrupted", 100)], "t2", 28_800).unwrap();
        assert_eq!(interrupted.template_id, "task_interrupted");
        assert_eq!(interrupted.valid_from, next_nine_am_local(100, 28_800));
        assert_eq!(
            interrupted.expires_at,
            interrupted.valid_from + model::ProactiveCategory::TaskUnresolved.window_seconds()
        );
    }

    #[test]
    fn completed_cancelled_and_running_tasks_never_remind() {
        for status in ["completed", "cancelled", "running", "waiting"] {
            assert!(task_candidate(&[record("t", status, 100)], "t", 0).is_none());
        }
    }

    #[test]
    fn retry_chains_share_the_root_identity() {
        let records = [
            record("root", "failed", 500), // the very first attempt failed
            {
                let mut retry = record("retry-1", "failed", 900);
                retry.resume_of = Some("root".into());
                retry
            },
        ];
        let from_retry = task_candidate(&records, "retry-1", 0).unwrap();
        assert_eq!(from_retry.dedupe_key, "task:root");
        assert_eq!(from_retry.source.id, "root");
        let from_root = task_candidate(&records, "root", 0).unwrap();
        assert_eq!(from_root.dedupe_key, from_retry.dedupe_key);
    }

    #[test]
    fn greeting_lives_in_a_half_hour_window() {
        let greeting = greeting_candidate("event-a", 1_000);
        assert_eq!(greeting.category, model::ProactiveCategory::Greeting);
        assert_eq!(greeting.template_id, "greeting");
        assert_eq!(greeting.dedupe_key, "greet:event-a");
        assert_eq!(greeting.expires_at - greeting.valid_from, GREETING_WINDOW);
    }

    #[test]
    fn queueing_twice_uses_one_identity() {
        let mut conn = Connection::open_in_memory().unwrap();
        store::migrate(&mut conn).unwrap();
        conn.execute_batch("INSERT INTO soul_control(singleton,revision,enabled,paused,enabled_since,cleared_through,category_settings) VALUES(1,1,1,0,0,0,'[{\"category\":\"task_unresolved\",\"enabled\":true},{\"category\":\"greeting\",\"enabled\":true}]');").unwrap();
        let records = vec![record("t1", "failed", 100)];
        queue_task_reminder(&mut conn, &records, "t1", 0, 100).unwrap();
        queue_task_reminder(&mut conn, &records, "t1", 0, 100).unwrap();
        let count = conn
            .query_row("SELECT count(*) FROM soul_proactive_ledger", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap();
        assert_eq!(count, 1);
        queue_greeting(&mut conn, "boot-1", 100).unwrap();
        queue_greeting(&mut conn, "boot-1", 100).unwrap();
        let count = conn
            .query_row("SELECT count(*) FROM soul_proactive_ledger", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap();
        assert_eq!(count, 2);
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReplyContext {
    pub message_id: String,
    pub source: model::SourceRef,
    pub verification_of: Option<String>,
}
pub fn reply_context(conn: &Connection, id: &str) -> Result<ReplyContext, String> {
    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT source_ref,template_id,state FROM soul_proactive_ledger WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|_| "ledger_unreadable")?;
    let (source, template, state) = row.ok_or("message_missing")?;
    if !matches!(state.as_str(), "shown" | "responded") {
        return Err("message_inactive".into());
    }
    let source: model::SourceRef =
        serde_json::from_str(&source).map_err(|_| "ledger_unreadable")?;
    let verification_of = if template == "task_interrupted" {
        Some(
            conn.query_row(
                "SELECT task_id FROM soul_task_followups WHERE root_id=?1 AND state='needs_check'",
                [&source.id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| "ledger_unreadable")?
            .ok_or("task_missing")?,
        )
    } else {
        None
    };
    Ok(ReplyContext {
        message_id: id.into(),
        source,
        verification_of,
    })
}

pub fn resolve(conn: &mut Connection, task_id: &str, now: i64) -> Result<(), String> {
    store::transaction(conn, |tx| {
        let root = tx
            .query_row(
                "SELECT root_id FROM soul_task_links WHERE task_id=?1",
                [task_id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| "ledger_unreadable")?
            .ok_or("task_missing")?;
        tx.execute(
            "UPDATE soul_task_followups SET state='resolved',updated_at=?2 WHERE root_id=?1",
            params![root, now],
        )
        .map_err(|_| "ledger_write_failed")?;
        tx.execute("UPDATE soul_proactive_ledger SET state='revoked',receipt_at=?2 WHERE dedupe_key=?1 AND state IN ('pending','dispatching','shown')",params![format!("task:{root}"),now]).map_err(|_| "ledger_write_failed")?;
        Ok(())
    })
}

#[cfg(test)]
mod closure_tests {
    use super::*;
    fn enabled() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        store::migrate(&mut conn).unwrap();
        conn.execute_batch("INSERT INTO soul_control(singleton,revision,enabled,paused,enabled_since,cleared_through,category_settings) VALUES(1,1,1,0,0,0,'[{\"category\":\"task_unresolved\",\"enabled\":true},{\"category\":\"greeting\",\"enabled\":true}]');").unwrap();
        conn
    }
    fn record(id: &str, status: &str, parent: Option<&str>, at: u64) -> TaskRecord {
        TaskRecord {
            request_id: id.into(),
            conversation_id: "test".into(),
            status: status.into(),
            started_at: at,
            updated_at: at,
            steps: vec![],
            resume_of: parent.map(str::to_string),
        }
    }
    #[test]
    fn completion_of_retry_revokes_old_message_and_durable_resolution_survives_truncation() {
        let mut conn = enabled();
        let first = record("original", "failed", None, 100);
        queue_task_reminder(&mut conn, &[first], "original", 0, 100).unwrap();
        let retry = record("retry", "completed", Some("original"), 200);
        queue_task_reminder(&mut conn, &[retry], "retry", 0, 200).unwrap();
        assert_eq!(
            conn.query_row("SELECT state FROM soul_proactive_ledger", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "revoked"
        );
        let later = record("later", "failed", Some("retry"), 300);
        queue_task_reminder(&mut conn, &[later], "later", 0, 300).unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM soul_proactive_ledger", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn disabled_period_events_are_not_replayed_after_enabling() {
        let mut conn = enabled();
        conn.execute("UPDATE soul_control SET enabled=0", [])
            .unwrap();
        let first = record("old", "failed", None, 100);
        queue_task_reminder(&mut conn, std::slice::from_ref(&first), "old", 0, 100).unwrap();
        queue_greeting(&mut conn, "old-start", 100).unwrap();
        conn.execute("UPDATE soul_control SET enabled=1,enabled_since=200", [])
            .unwrap();
        queue_task_reminder(&mut conn, &[first], "old", 0, 201).unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM soul_proactive_ledger", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn explicit_resolution_is_not_an_execution_and_withdraws_queue() {
        let mut conn = enabled();
        queue_task_reminder(
            &mut conn,
            &[record("task", "interrupted", None, 100)],
            "task",
            0,
            100,
        )
        .unwrap();
        resolve(&mut conn, "task", 200).unwrap();
        assert_eq!(
            conn.query_row("SELECT state FROM soul_task_followups", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "resolved"
        );
        assert_eq!(
            conn.query_row("SELECT state FROM soul_proactive_ledger", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "revoked"
        );
    }
}

#[cfg(test)]
mod timezone_tests {
    use super::*;
    use chrono::TimeZone;
    #[test]
    fn next_day_nine_uses_target_date_dst_offset() {
        let zone = chrono_tz::America::New_York;
        for (date, expected_hours) in [((2026, 3, 7), 23), ((2026, 10, 31), 25)] {
            let source = zone
                .with_ymd_and_hms(date.0, date.1, date.2, 9, 0, 0)
                .unwrap();
            let due = next_nine_in_zone(source.timestamp(), &zone).unwrap();
            assert_eq!(due - source.timestamp(), expected_hours * 3600);
            let local = zone.timestamp_opt(due, 0).unwrap();
            assert_eq!(
                local.time(),
                chrono::NaiveTime::from_hms_opt(9, 0, 0).unwrap()
            );
        }
        let source = zone.with_ymd_and_hms(2026, 3, 7, 23, 30, 0).unwrap();
        let due = zone
            .timestamp_opt(next_nine_in_zone(source.timestamp(), &zone).unwrap(), 0)
            .unwrap();
        assert_eq!(
            due.date_naive(),
            chrono::NaiveDate::from_ymd_opt(2026, 3, 8).unwrap()
        );
    }
}
