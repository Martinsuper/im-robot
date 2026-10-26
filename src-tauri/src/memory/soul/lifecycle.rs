//! Retention removes payloads but retains identities until source deletion.
use super::{model::*, store};
use rusqlite::{params, Connection};

pub fn sweep(conn: &mut Connection, now: i64) -> Result<(), String> {
    store::transaction(conn, |tx| {
        tx.execute(
            "DELETE FROM soul_topic_responses WHERE coalesce(reviewed_at,created_at)<?1",
            [now - 30 * 86400],
        )
        .map_err(|_| crate::error_codes::LEDGER_WRITE_FAILED)?;
        tx.execute(
            "DELETE FROM soul_output_observations WHERE created_at<?1",
            [now - 30 * 86400],
        )
        .map_err(|_| crate::error_codes::LEDGER_WRITE_FAILED)?;
        tx.execute(
            "DELETE FROM soul_evidence WHERE occurred_at<?1",
            [now - 90 * 86400],
        )
        .map_err(|_| crate::error_codes::LEDGER_WRITE_FAILED)?;

        tx.execute("INSERT OR IGNORE INTO soul_candidate_tombstones SELECT dedupe_key,source_ref,?1 FROM soul_candidates WHERE created_at<?2 AND (status='pending_review' OR reviewed_at<?2)",params![now,now-CANDIDATE_RETENTION_SECONDS]).map_err(|_| crate::error_codes::RETENTION_FAILED)?;
        tx.execute("DELETE FROM soul_candidates WHERE dedupe_key IN (SELECT dedupe_key FROM soul_candidate_tombstones)",[]).map_err(|_| crate::error_codes::RETENTION_FAILED)?;
        tx.execute("DELETE FROM soul_open_loops WHERE state IN ('closed','cancelled','expired') AND closed_at<?1",[now-TOPIC_RETENTION_SECONDS]).map_err(|_| crate::error_codes::RETENTION_FAILED)?;
        tx.execute("INSERT OR IGNORE INTO soul_delivery_tombstones SELECT dedupe_key,source_ref,?1 FROM soul_proactive_ledger WHERE state NOT IN ('pending','dispatching','shown') AND coalesce(receipt_at,created_at)<?2",params![now,now-LEDGER_RETENTION_SECONDS]).map_err(|_| crate::error_codes::RETENTION_FAILED)?;
        tx.execute("DELETE FROM soul_proactive_ledger WHERE dedupe_key IN (SELECT dedupe_key FROM soul_delivery_tombstones) AND state NOT IN ('pending','dispatching','shown')",[]).map_err(|_| crate::error_codes::RETENTION_FAILED)?;
        Ok(())
    })
}

/// Write source tombstones before deleting its external file/record. A retry
/// can finish deletion, but a crash can never make an old source extractable.
pub fn delete_sources(conn: &mut Connection, ids: &[String], now: i64) -> Result<(), String> {
    store::transaction(conn, |tx| {
        for id in ids {
            tx.execute("UPDATE soul_proactive_ledger SET state='revoked',receipt_at=?2 WHERE id IN(SELECT observation_id FROM soul_observation_sources WHERE source_id=?1) AND state IN ('pending','dispatching','shown')",params![id,now]).map_err(|_|crate::error_codes::SOURCE_DELETE_FAILED)?;
            tx.execute(
                "DELETE FROM soul_evidence WHERE json_extract(source_ref,'$.id')=?1",
                [id],
            )
            .map_err(|_| crate::error_codes::SOURCE_DELETE_FAILED)?;
            tx.execute(
                "DELETE FROM soul_output_observations WHERE json_extract(source_ref,'$.id')=?1",
                [id],
            )
            .map_err(|_| crate::error_codes::SOURCE_DELETE_FAILED)?;
            tx.execute("DELETE FROM soul_topic_responses WHERE topic_id IN(SELECT id FROM soul_open_loops WHERE json_extract(source_ref,'$.id')=?1)",[id]).map_err(|_|crate::error_codes::SOURCE_DELETE_FAILED)?;
            tx.execute("UPDATE soul_candidates SET status='rejected',reviewed_at=?1 WHERE kind='evolution' AND status='pending_review'",[now]).map_err(|_|crate::error_codes::SOURCE_DELETE_FAILED)?;

            tx.execute("INSERT INTO soul_source_tombstones(source_id,deleted_at) VALUES(?1,?2) ON CONFLICT(source_id) DO UPDATE SET deleted_at=excluded.deleted_at",params![id,now]).map_err(|_| crate::error_codes::SOURCE_DELETE_FAILED)?;
            tx.execute("UPDATE soul_proactive_ledger SET state='revoked',receipt_at=?2 WHERE (json_extract(source_ref,'$.id')=?1 OR json_extract(source_ref,'$.id') IN (SELECT id FROM soul_open_loops WHERE json_extract(source_ref,'$.id')=?1)) AND state IN ('pending','dispatching','shown')",params![id,now]).map_err(|_| crate::error_codes::SOURCE_DELETE_FAILED)?;
            tx.execute(
                "DELETE FROM soul_candidates WHERE json_extract(source_ref,'$.id')=?1",
                [id],
            )
            .map_err(|_| crate::error_codes::SOURCE_DELETE_FAILED)?;
            tx.execute(
                "DELETE FROM soul_open_loops WHERE json_extract(source_ref,'$.id')=?1",
                [id],
            )
            .map_err(|_| crate::error_codes::SOURCE_DELETE_FAILED)?;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::soul::{open_loops, proactive, settings};
    fn db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        store::migrate(&mut conn).unwrap();
        conn
    }
    fn entry() -> crate::chat_session::ChatHistoryEntry {
        crate::chat_session::ChatHistoryEntry {
            conversation_id: None,
            id: "source".into(),
            prompt: "我打算下周去爬山".into(),
            response: "".into(),
            created_at: 100,
        }
    }
    #[test]
    fn expired_candidate_payloads_are_removed_without_reintroducing_rejected_sources() {
        let mut conn = db();
        store::transaction(&mut conn, |tx| {
            open_loops::enqueue(tx, &entry(), 100, "Asia/Shanghai")
        })
        .unwrap();
        sweep(&mut conn, 100 + CANDIDATE_RETENTION_SECONDS + 1).unwrap();
        assert!(open_loops::pending(&conn).unwrap().candidates.is_empty());
        let added = store::transaction(&mut conn, |tx| {
            open_loops::enqueue(tx, &entry(), 4_000_000, "Asia/Shanghai")
        })
        .unwrap();
        assert_eq!(added, 0);
        assert_eq!(
            conn.query_row("SELECT count(*) FROM soul_candidate_tombstones", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
            1
        );
    }
    #[test]
    fn failed_retention_rolls_back_payload_and_tombstone_together() {
        let mut conn = db();
        store::transaction(&mut conn, |tx| {
            open_loops::enqueue(tx, &entry(), 100, "Asia/Shanghai")
        })
        .unwrap();
        conn.execute_batch("CREATE TRIGGER stop_delete BEFORE DELETE ON soul_candidates BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
        assert!(sweep(&mut conn, 100 + CANDIDATE_RETENTION_SECONDS + 1).is_err());
        assert_eq!(open_loops::pending(&conn).unwrap().candidates.len(), 1);
        assert_eq!(
            conn.query_row("SELECT count(*) FROM soul_candidate_tombstones", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
            0
        );
    }
    #[test]
    fn clearing_and_source_deletion_prevent_rebuilding_old_topics() {
        let mut conn = db();
        settings::get(&mut conn, 100).unwrap();
        settings::clear(&mut conn, &[SoulDataScope::All], 200).unwrap();
        assert_eq!(
            store::transaction(&mut conn, |tx| open_loops::enqueue(
                tx,
                &entry(),
                300,
                "Asia/Shanghai"
            ))
            .unwrap(),
            0
        );
        let mut new = entry();
        new.id = "new-source".into();
        new.created_at = 301;
        assert_eq!(
            store::transaction(&mut conn, |tx| open_loops::enqueue(
                tx,
                &new,
                302,
                "Asia/Shanghai"
            ))
            .unwrap(),
            1
        );
        delete_sources(&mut conn, &[new.id.clone()], 303).unwrap();
        assert!(open_loops::pending(&conn).unwrap().candidates.is_empty());
        assert_eq!(
            store::transaction(&mut conn, |tx| open_loops::enqueue(
                tx,
                &new,
                304,
                "Asia/Shanghai"
            ))
            .unwrap(),
            0
        );
    }
    #[test]
    fn ledger_detail_retention_preserves_one_attempt_identity() {
        let mut conn = db();
        let message = ProactiveMessage {
            id: "message".into(),
            category: ProactiveCategory::TaskUnresolved,
            source: SourceRef {
                kind: "agent_task".into(),
                id: "task".into(),
                revision: 1,
            },
            dedupe_key: "task:task".into(),
            template_id: "task_failed".into(),
            valid_from: 100,
            expires_at: 200,
            state: DeliveryState::Pending,
        };
        store::transaction(&mut conn, |tx| proactive::queue(tx, message.clone(), 100)).unwrap();
        conn.execute(
            "UPDATE soul_proactive_ledger SET state='uncertain',receipt_at=101",
            [],
        )
        .unwrap();
        sweep(&mut conn, 101 + LEDGER_RETENTION_SECONDS + 1).unwrap();
        store::transaction(&mut conn, |tx| proactive::queue(tx, message, 5_000_000)).unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM soul_proactive_ledger", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
