//! Local, confirmed-topic followups. Responses propose changes; they never apply them.
use super::{model::*, open_loops, proactive, store};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
const DAY: i64 = 86400;
#[derive(Debug, Serialize, Deserialize)]
pub struct TopicResponse {
    pub id: String,
    pub message_id: String,
    pub topic_id: String,
    pub expected_revision: i64,
    pub proposed_state: Option<String>,
    pub proposed_time: Option<OpenLoopTime>,
    pub status: String,
}
pub fn produce_topics(conn: &mut Connection, now: i64) -> Result<(), String> {
    store::transaction(conn, |tx| {
        // Business expiry is independent of whether proactive delivery is enabled.
        tx.execute("UPDATE soul_open_loops SET state='expired',closed_at=?1,revision=revision+1,updated_at=?1 WHERE state IN ('tracking','due') AND ends_at IS NOT NULL AND ends_at+604800<?1",[now]).map_err(|_|"ledger_write_failed")?;
        tx.execute("UPDATE soul_proactive_ledger SET state='revoked',receipt_at=?1 WHERE category='open_loop' AND state IN ('pending','dispatching','shown') AND NOT EXISTS(SELECT 1 FROM soul_open_loops WHERE id=json_extract(soul_proactive_ledger.source_ref,'$.id') AND revision=json_extract(soul_proactive_ledger.source_ref,'$.revision') AND state IN ('tracking','due'))",[now]).map_err(|_|"ledger_write_failed")?;
        if !proactive::event_allowed(tx, ProactiveCategory::OpenLoop, now)? {
            return Ok(());
        }
        let topics = open_loops::list(tx, None)?;
        for topic in topics {
            if !matches!(topic.state, OpenLoopState::Tracking | OpenLoopState::Due) {
                continue;
            }
            let Some(end) = topic.time.ends_at else {
                continue;
            };
            if now <= end || now > end + 7 * DAY {
                continue;
            }
            // Do not replay due windows which began while this category was disabled.
            let baseline: i64 = tx
                .query_row(
                    "SELECT coalesce(enabled_since,0) FROM soul_control WHERE singleton=1",
                    [],
                    |r| r.get(0),
                )
                .map_err(|_| "ledger_unreadable")?;
            let category_baseline: i64 = tx
                .query_row(
                    "SELECT enabled_since FROM soul_category_baselines WHERE category='open_loop'",
                    [],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|_| "ledger_unreadable")?
                .unwrap_or(0);
            if end < baseline.max(category_baseline) {
                continue;
            }
            let raw = serde_json::to_string(&SourceRef {
                kind: "open_loop".into(),
                id: topic.id.clone(),
                revision: topic.revision,
            })
            .map_err(|_| "invalid_source")?;
            let retired: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM soul_source_tombstones WHERE source_id=?1)",
                    [&topic.source.id],
                    |r| r.get(0),
                )
                .map_err(|_| "ledger_unreadable")?;
            if retired {
                continue;
            }
            let last:Option<i64>=tx.query_row("SELECT max(created_at) FROM soul_proactive_ledger WHERE category='open_loop' AND json_extract(source_ref,'$.id')=?1",[&topic.id],|r|r.get(0)).map_err(|_|"ledger_unreadable")?;
            if last.is_some_and(|last| now < last + 7 * DAY) {
                continue;
            }
            if matches!(topic.state, OpenLoopState::Tracking) {
                tx.execute("UPDATE soul_open_loops SET state='due',updated_at=?2 WHERE id=?1 AND revision=?3",params![topic.id,now,topic.revision]).map_err(|_|"ledger_write_failed")?;
            }
            let source = serde_json::from_str(&raw).map_err(|_| "invalid_source")?;
            proactive::queue(
                tx,
                ProactiveMessage {
                    id: format!("topic-{}-{}", topic.id, topic.revision),
                    category: ProactiveCategory::OpenLoop,
                    source,
                    dedupe_key: format!("topic:{}:{}", topic.id, topic.revision),
                    template_id: "open_loop_followup".into(),
                    valid_from: end + 1,
                    expires_at: end + 7 * DAY,
                    state: DeliveryState::Pending,
                },
                now,
            )?;
        }
        Ok(())
    })
}
pub fn propose(
    conn: &mut Connection,
    message_id: &str,
    text: &str,
    now: i64,
) -> Result<String, String> {
    let context = super::tasks::reply_context(conn, message_id)?;
    if context.source.kind != "open_loop" {
        return Ok("not_topic".into());
    }
    let topic = open_loops::list(conn, None)?
        .into_iter()
        .find(|t| t.id == context.source.id)
        .ok_or("topic_missing")?;
    if topic.revision != context.source.revision
        || !matches!(topic.state, OpenLoopState::Tracking | OpenLoopState::Due)
    {
        return Err("revision_conflict".into());
    }
    let text = text.trim().trim_end_matches(['。', '.', '!', '！']);
    let (state, time) = match text {
        "完成了" | "已经完成" | "done" | "completed" | "完了した" => {
            (Some("closed"), None)
        }
        "取消了" | "取消" | "cancelled" | "canceled" | "中止した" => {
            (Some("cancelled"), None)
        }
        "还没" | "还没有" | "not yet" | "まだ" => return Ok("unchanged".into()),
        _ => {
            let expression = ["改到", "延期到", "reschedule to ", "変更日："]
                .iter()
                .find_map(|prefix| text.strip_prefix(prefix));
            let Some(expression) = expression else {
                return Ok("clarify".into());
            };
            let proposed = open_loops::resolve_time(&OpenLoopTime {
                expression: Some(expression.trim().into()),
                baseline: now,
                timezone: topic.time.timezone.clone(),
                starts_at: None,
                ends_at: None,
                parser_version: String::new(),
            })?;
            if proposed.starts_at.is_none() {
                return Ok("clarify".into());
            }
            (Some("tracking"), Some(proposed))
        }
    };
    let id = format!("response-{message_id}");
    let changed=conn.execute("INSERT INTO soul_topic_responses(id,message_id,topic_id,expected_revision,proposed_state,proposed_time,status,created_at) VALUES(?1,?2,?3,?4,?5,?6,'pending_review',?7) ON CONFLICT(id) DO NOTHING",params![id,message_id,topic.id,topic.revision,state,time.map(|time|serde_json::to_string(&time).unwrap()),now]).map_err(|_|"ledger_write_failed")?;
    if changed==0 {
        return conn.query_row("SELECT status FROM soul_topic_responses WHERE id=?1",[&id],|r|r.get(0)).map_err(|_|"ledger_unreadable".into());
    }
    Ok("pending_review".into())
}
pub fn responses(conn: &Connection) -> Result<Vec<TopicResponse>, String> {
    let mut stmt=conn.prepare("SELECT id,message_id,topic_id,expected_revision,proposed_state,proposed_time,status FROM soul_topic_responses WHERE status='pending_review' ORDER BY created_at DESC").map_err(|_|"ledger_unreadable")?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, String>(6)?,
            ))
        })
        .map_err(|_| "ledger_unreadable")?;
    rows.map(|row| {
        let (id, message_id, topic_id, expected_revision, proposed_state, time, status) =
            row.map_err(|_| "ledger_unreadable")?;
        Ok(TopicResponse {
            id,
            message_id,
            topic_id,
            expected_revision,
            proposed_state,
            proposed_time: time
                .map(|raw| serde_json::from_str(&raw))
                .transpose()
                .map_err(|_| "invalid_loop_time")?,
            status,
        })
    })
    .collect()
}
pub fn review_response(
    conn: &mut Connection,
    id: &str,
    approve: bool,
    now: i64,
) -> Result<(), String> {
    // Existing update() owns its own transaction; perform the same CAS and revocation
    // here so candidate review and the approved mutation share one commit.
    store::transaction(conn, |tx| {
        let candidate = responses(tx)?
            .into_iter()
            .find(|r| r.id == id)
            .ok_or("candidate_missing")?;
        if approve {
            tx.execute("UPDATE soul_proactive_ledger SET state='revoked',receipt_at=?1 WHERE category='pattern' AND state IN ('pending','dispatching','shown')",[now]).map_err(|_|"ledger_write_failed")?;

            let current:Option<i64>=tx.query_row("SELECT revision FROM soul_open_loops WHERE id=?1 AND state IN ('tracking','due')",[&candidate.topic_id],|r|r.get(0)).optional().map_err(|_|"ledger_unreadable")?;
            if current != Some(candidate.expected_revision) {
                return Err("revision_conflict".into());
            }
            let state = candidate
                .proposed_state
                .as_deref()
                .ok_or("invalid_review")?;
            if !matches!(state, "closed" | "cancelled" | "tracking") {
                return Err("invalid_review".into());
            }
            if let Some(time) = candidate.proposed_time {
                tx.execute("UPDATE soul_open_loops SET revision=revision+1,state='tracking',time_expression=?2,time_baseline=?3,timezone=?4,starts_at=?5,ends_at=?6,parser_version=?7,updated_at=?8,closed_at=NULL WHERE id=?1",params![candidate.topic_id,time.expression,time.baseline,time.timezone,time.starts_at,time.ends_at,time.parser_version,now]).map_err(|_|"ledger_write_failed")?;
            } else {
                tx.execute("UPDATE soul_open_loops SET revision=revision+1,state=?2,updated_at=?3,closed_at=?3 WHERE id=?1",params![candidate.topic_id,state,now]).map_err(|_|"ledger_write_failed")?;
            }
            tx.execute("UPDATE soul_proactive_ledger SET state='revoked',receipt_at=?2 WHERE category='open_loop' AND json_extract(source_ref,'$.id')=?1 AND state IN ('pending','dispatching','shown')",params![candidate.topic_id,now]).map_err(|_|"ledger_write_failed")?;
        }
        tx.execute(
            "UPDATE soul_topic_responses SET status=?2,reviewed_at=?3 WHERE id=?1",
            params![id, if approve { "approved" } else { "rejected" }, now],
        )
        .map_err(|_| "ledger_write_failed")?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        store::migrate(&mut c).unwrap();
        c.execute("INSERT INTO soul_control(singleton,revision,enabled,paused,enabled_since,cleared_through,category_settings) VALUES(1,1,1,0,0,0,'[{\"category\":\"open_loop\",\"enabled\":true}]')",[]).unwrap();
        c.execute("INSERT INTO soul_open_loops(id,revision,content,source_ref,time_baseline,timezone,starts_at,ends_at,parser_version,state,created_at,updated_at) VALUES('topic',1,'A plan','{\"kind\":\"chat\",\"id\":\"source\",\"revision\":1}',100,'Asia/Shanghai',100,200,'test','tracking',100,100)",[]).unwrap();
        c
    }
    #[test]
    fn due_queue_is_deduped_and_ambiguous_or_not_yet_does_not_mutate() {
        let mut c = db();
        produce_topics(&mut c, 201).unwrap();
        produce_topics(&mut c, 202).unwrap();
        assert_eq!(
            c.query_row("SELECT count(*) FROM soul_proactive_ledger", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        c.execute("UPDATE soul_proactive_ledger SET state='shown'", [])
            .unwrap();
        assert_eq!(
            propose(&mut c, "topic-topic-1", "not yet", 202).unwrap(),
            "unchanged"
        );
        assert_eq!(
            propose(&mut c, "topic-topic-1", "done or perhaps tomorrow", 202).unwrap(),
            "clarify"
        );
        assert!(responses(&c).unwrap().is_empty());
        assert_eq!(
            propose(&mut c, "topic-topic-1", "done", 202).unwrap(),
            "pending_review"
        );
        assert_eq!(open_loops::list(&c, None).unwrap()[0].revision, 1);
        c.execute_batch("CREATE TRIGGER fail_revoke BEFORE UPDATE ON soul_proactive_ledger BEGIN SELECT RAISE(ABORT,'test'); END").unwrap();
        assert!(review_response(&mut c, "response-topic-topic-1", true, 203).is_err());
        assert_eq!(responses(&c).unwrap().len(), 1);
        assert_eq!(open_loops::list(&c, None).unwrap()[0].revision, 1);
        c.execute_batch("DROP TRIGGER fail_revoke").unwrap();
        review_response(&mut c, "response-topic-topic-1", true, 203).unwrap();
        assert!(matches!(
            open_loops::list(&c, None).unwrap()[0].state,
            OpenLoopState::Closed
        ));
    }
    #[test]
    fn category_baseline_prevents_replay_and_old_proposal_cannot_overwrite() {
        let mut c = db();
        c.execute(
            "INSERT INTO soul_category_baselines VALUES('open_loop',201)",
            [],
        )
        .unwrap();
        produce_topics(&mut c, 202).unwrap();
        assert_eq!(
            c.query_row("SELECT count(*) FROM soul_proactive_ledger", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        c.execute("DELETE FROM soul_category_baselines", [])
            .unwrap();
        produce_topics(&mut c, 202).unwrap();
        c.execute("UPDATE soul_proactive_ledger SET state='shown'", [])
            .unwrap();
        propose(&mut c, "topic-topic-1", "cancelled", 203).unwrap();
        c.execute("UPDATE soul_open_loops SET revision=2", [])
            .unwrap();
        assert_eq!(
            review_response(&mut c, "response-topic-topic-1", true, 204).unwrap_err(),
            "revision_conflict"
        );
        produce_topics(&mut c, 201 + 7 * DAY).unwrap();
        assert!(matches!(
            open_loops::list(&c, None).unwrap()[0].state,
            OpenLoopState::Expired
        ));
    }
}

#[cfg(test)]
mod reschedule_tests {
    use super::*;
    #[test]
    fn proposed_new_date_is_fixed_and_rejection_never_changes_topic() {
        let mut c = Connection::open_in_memory().unwrap();
        store::migrate(&mut c).unwrap();
        c.execute("INSERT INTO soul_open_loops(id,revision,content,source_ref,time_baseline,timezone,starts_at,ends_at,parser_version,state,created_at,updated_at) VALUES('topic',1,'plan','{\"kind\":\"chat\",\"id\":\"source\",\"revision\":1}',100,'America/New_York',100,200,'test','due',100,100)",[]).unwrap();
        c.execute("INSERT INTO soul_proactive_ledger(id,category,source_ref,dedupe_key,template_id,valid_from,expires_at,state,created_at) VALUES('message','open_loop','{\"kind\":\"open_loop\",\"id\":\"topic\",\"revision\":1}','key','open_loop_followup',100,9999999999,'shown',100)",[]).unwrap();
        assert_eq!(
            propose(&mut c, "message", "改到2026-11-02", 1000).unwrap(),
            "pending_review"
        );
        let candidate = responses(&c).unwrap().pop().unwrap();
        let time = candidate.proposed_time.unwrap();
        assert!(time.starts_at.is_some());
        assert_eq!(time.timezone, "America/New_York");
        review_response(&mut c, "response-message", false, 1001).unwrap();
        assert_eq!(open_loops::list(&c, None).unwrap()[0].revision, 1);
        assert_eq!(
            propose(&mut c, "message", "done", 1002).unwrap(),
            "rejected"
        );
        assert!(responses(&c).unwrap().is_empty());
    }
}
