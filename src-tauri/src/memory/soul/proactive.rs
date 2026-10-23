//! Proactive-message ledger and the S06 scheduling kernel. Delivery always
//! reserves dedupe identity and quota in one transaction; failures and
//! restarts never hand out extra messages or resurrect state unknown.
use super::store;
use crate::memory::soul::model::{
    DeliveryState, MessageReceipt, ProactiveCategory, ProactiveMessage, ReceiptKind,
    COOLDOWN_SECONDS, DAILY_LIMIT,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const DAY: i64 = 86_400;

/// In-process cooldown baseline. Disk state is written inside the reservation
/// transaction; this process-local clock moves only after a commit.
pub struct Cooldown {
    baseline: Option<Instant>,
}

impl Cooldown {
    pub fn idle() -> Self {
        Self { baseline: None }
    }

    /// Restart with any historical delivery conservatively observes a full
    /// cooldown even when the persisted quota would allow an earlier dispatch.
    pub fn parked(monotonic: Instant) -> Self {
        Self {
            baseline: Some(monotonic),
        }
    }

    pub fn arm(&mut self, monotonic: Instant) {
        self.baseline = Some(monotonic);
    }

    pub fn ready(&self, monotonic: Instant) -> bool {
        match self.baseline {
            None => true,
            Some(baseline) => monotonic
                .checked_duration_since(baseline)
                .is_some_and(|elapsed| elapsed >= Duration::from_secs(COOLDOWN_SECONDS as u64)),
        }
    }
}

/// Time inputs for one reservation attempt. `offset_seconds` is the local UTC
/// offset of the persisted timezone; `timezone` is recorded informationally
/// and never used to rebuild the single quota bucket.
#[derive(Debug, Clone)]
pub struct DispatchClock {
    pub unix_now: i64,
    pub offset_seconds: i64,
    pub timezone: String,
    pub monotonic: Instant,
}

fn date_of(day: i64) -> String {
    let (y, m, d) = super::open_loops::civil_from_days(day);
    format!("{y:04}-{m:02}-{d:02}")
}

fn category_name(category: ProactiveCategory) -> String {
    serde_json::to_value(category)
        .ok()
        .and_then(|value| value.as_str().map(|s| s.to_string()))
        .unwrap_or_default()
}

fn category_used_value(raw: &str) -> Result<Value, String> {
    let value: Value =
        serde_json::from_str(raw).map_err(|_| crate::error_codes::LEDGER_UNREADABLE.to_string())?;
    if !value.is_object() {
        return Err(crate::error_codes::LEDGER_UNREADABLE.into());
    }
    Ok(value)
}

/// Fail-closed queue entry: a duplicate dedupe key is silently ignored so the
/// same source can never create a second message identity.
pub fn queue(
    tx: &Transaction<'_>,
    mut message: ProactiveMessage,
    now_unix: i64,
) -> Result<(), String> {
    if message.expires_at <= message.valid_from {
        return Err(crate::error_codes::INVALID_MESSAGE_WINDOW.into());
    }
    let retired: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM soul_delivery_tombstones WHERE dedupe_key=?1)",
            [&message.dedupe_key],
            |row| row.get(0),
        )
        .map_err(|_| crate::error_codes::LEDGER_UNREADABLE)?;
    if retired {
        return Ok(());
    }
    message.state = DeliveryState::Pending;
    tx.execute(
        "INSERT INTO soul_proactive_ledger(id,category,source_ref,dedupe_key,template_id,valid_from,expires_at,state,created_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,'pending',?8)
         ON CONFLICT(dedupe_key) DO NOTHING",
        params![
            message.id,
            serde_json::to_value(message.category)
                .ok()
                .and_then(|value| value.as_str().map(|s| s.to_string()))
                .ok_or(crate::error_codes::INVALID_MESSAGE.to_string())?,
            serde_json::to_string(&message.source).map_err(|_| crate::error_codes::INVALID_MESSAGE.to_string())?,
            message.dedupe_key,
            message.template_id,
            message.valid_from,
            message.expires_at,
            now_unix,
        ],
    )
    .map_err(|_| crate::error_codes::LEDGER_WRITE_FAILED.to_string())?;
    Ok(())
}

struct Gate {
    enabled: bool,
    paused: bool,
    category_enabled: HashMap<String, bool>,
}

fn read_gate(tx: &Transaction<'_>) -> Result<Gate, String> {
    let row = tx
        .query_row(
            "SELECT enabled,paused,category_settings FROM soul_control WHERE singleton=1",
            [],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|_| crate::error_codes::LEDGER_UNREADABLE.to_string())?;
    Ok(match row {
        // A missing control record fails closed: proactive stays silent until
        // the settings layer persists explicit switches.
        None => Gate {
            enabled: false,
            paused: false,
            category_enabled: HashMap::new(),
        },
        Some((enabled, paused, settings)) => {
            let parsed: Vec<Value> = serde_json::from_str(&settings)
                .map_err(|_| crate::error_codes::LEDGER_UNREADABLE.to_string())?;
            let mut category_enabled = HashMap::new();
            for entry in parsed {
                let name = entry.get("category").and_then(Value::as_str);
                let enabled = entry.get("enabled").and_then(Value::as_bool);
                if let (Some(name), Some(enabled)) = (name, enabled) {
                    category_enabled.insert(name.to_string(), enabled);
                }
            }
            Gate {
                enabled: enabled == 1,
                paused: paused == 1,
                category_enabled,
            }
        }
    })
}

/// Candidates inside their valid window and allowed by persisted switches,
/// ordered by category priority then id. Corrupt rows surface as errors
/// instead of being silently reported as an empty queue.
fn candidates_allowed_by_gate(
    tx: &Transaction<'_>,
    clock: &DispatchClock,
) -> Result<Vec<ProactiveMessage>, String> {
    let gate = read_gate(tx)?;
    if !gate.enabled || gate.paused {
        return Ok(vec![]);
    }
    let mut statement = tx
        .prepare(
            "SELECT id,category,source_ref,dedupe_key,template_id,valid_from,expires_at FROM soul_proactive_ledger
             WHERE state='pending' AND valid_from<=?1 AND expires_at>?1 AND created_at>=coalesce((SELECT enabled_since FROM soul_control WHERE singleton=1),0)",
        )
        .map_err(|_| crate::error_codes::LEDGER_UNREADABLE.to_string())?;
    let mut rows = statement
        .query(params![clock.unix_now])
        .map_err(|_| crate::error_codes::LEDGER_UNREADABLE.to_string())?;
    let mut items: Vec<ProactiveMessage> = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|_| crate::error_codes::LEDGER_UNREADABLE.to_string())?
    {
        let raw_category: String = row
            .get(1)
            .map_err(|_| crate::error_codes::LEDGER_UNREADABLE.to_string())?;
        let category =
            serde_json::from_value::<ProactiveCategory>(Value::String(raw_category.clone()))
                .map_err(|_| crate::error_codes::LEDGER_UNREADABLE.to_string())?;
        if gate.category_enabled.get(&raw_category).copied() != Some(true) {
            continue;
        }
        items.push(ProactiveMessage {
            id: row
                .get(0)
                .map_err(|_| crate::error_codes::LEDGER_UNREADABLE.to_string())?,
            category,
            source: serde_json::from_str(
                &row.get::<_, String>(2)
                    .map_err(|_| crate::error_codes::LEDGER_UNREADABLE.to_string())?,
            )
            .map_err(|_| crate::error_codes::LEDGER_UNREADABLE.to_string())?,
            dedupe_key: row
                .get(3)
                .map_err(|_| crate::error_codes::LEDGER_UNREADABLE.to_string())?,
            template_id: row
                .get(4)
                .map_err(|_| crate::error_codes::LEDGER_UNREADABLE.to_string())?,
            valid_from: row
                .get(5)
                .map_err(|_| crate::error_codes::LEDGER_UNREADABLE.to_string())?,
            expires_at: row
                .get(6)
                .map_err(|_| crate::error_codes::LEDGER_UNREADABLE.to_string())?,
            state: DeliveryState::Pending,
        });
    }
    items.sort_by(|left, right| {
        left.category
            .priority()
            .cmp(&right.category.priority())
            .then(left.id.cmp(&right.id))
    });
    Ok(items)
}

/// Attempt one dispatch. Reservation and the state flip commit together; the
/// process-local cooldown arms only after a successful commit.
pub fn reserve(
    conn: &mut Connection,
    cooldown: &mut Cooldown,
    clock: DispatchClock,
) -> Result<Option<ProactiveMessage>, String> {
    let monotonic = clock.monotonic;
    if !cooldown.ready(monotonic) {
        return Ok(None);
    }
    let outcome = store::transaction(conn, |tx| reserve_in(tx, &clock))?;
    if outcome.is_some() {
        cooldown.arm(monotonic);
    }
    Ok(outcome)
}

fn reserve_in(
    tx: &Transaction<'_>,
    clock: &DispatchClock,
) -> Result<Option<ProactiveMessage>, String> {
    for message in candidates_allowed_by_gate(tx, clock)? {
        match reserve_quota(tx, &message, clock) {
            Ok(Some(())) => return Ok(Some(message)),
            // This category is out of quota but others may still have room.
            Ok(None) => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(None)
}

fn reserve_quota(
    tx: &Transaction<'_>,
    message: &ProactiveMessage,
    clock: &DispatchClock,
) -> Result<Option<()>, String> {
    type QuotaRow = (String, String, i64, i64, i64, String, Option<i64>);
    let quota: Option<QuotaRow> = tx
        .query_row(
            "SELECT local_date,timezone,high_water_at,reset_not_before,total_used,category_used,last_dispatch_at FROM soul_quota WHERE singleton=1",
            [],
            |r| {
                Ok((
                    r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?,
                    r.get(4)?, r.get(5)?, r.get(6)?,
                ))
            },
        )
        .optional()
        .map_err(|_| crate::error_codes::LEDGER_UNREADABLE.to_string())?;
    let (
        mut local_date,
        timezone,
        mut high_water,
        mut reset_not_before,
        mut total_used,
        category_used_raw,
        last_dispatch_at,
    ) = match quota {
        Some(row) => row,
        None => (
            date_of((clock.unix_now + clock.offset_seconds).div_euclid(DAY)),
            clock.timezone.clone(),
            clock.unix_now,
            clock.unix_now + DAY,
            0,
            "{}".to_string(),
            None,
        ),
    };
    // Wall-clock rollback or a stale persisted dispatch must never spend quota.
    if clock.unix_now < high_water {
        return Ok(None);
    }
    if last_dispatch_at.is_some_and(|at| at > clock.unix_now) {
        return Ok(None);
    }
    let mut category_used = category_used_value(&category_used_raw)?;
    let name = category_name(message.category);
    let used = category_used
        .get(&name)
        .and_then(Value::as_i64)
        .unwrap_or(0);
    // One persistent bucket: the day label advances strictly forward and only
    // after its reset guard, so rollback or timezone jumps cannot renew quota.
    let today_str = date_of((clock.unix_now + clock.offset_seconds).div_euclid(DAY));
    if today_str > local_date && clock.unix_now >= reset_not_before {
        local_date = today_str;
        total_used = 0;
        category_used = json!({});
        reset_not_before = high_water.saturating_add(DAY);
    } else if today_str != local_date {
        // A crossed local midnight without its guard stays on the old bucket;
        // conservative postponement avoids extra quota.
        return Ok(None);
    }
    if total_used >= DAILY_LIMIT as i64 {
        return Ok(None);
    }
    let backed_off: bool = tx.query_row(
        "SELECT consecutive_ignored>=3 AND recover_after>?2 FROM soul_backoff WHERE category=?1",
        params![name, clock.unix_now], |row| row.get(0),
    ).optional().map_err(|_| crate::error_codes::LEDGER_UNREADABLE)?.unwrap_or(false);
    if backed_off {
        let last: Option<i64> = tx
            .query_row(
                "SELECT max(dispatching_at) FROM soul_proactive_ledger WHERE category=?1",
                [&name],
                |row| row.get(0),
            )
            .map_err(|_| crate::error_codes::LEDGER_UNREADABLE)?;
        if last.is_some_and(|at| clock.unix_now.saturating_sub(at) < COOLDOWN_SECONDS * 2) {
            return Ok(None);
        }
    }
    let category_limit = if backed_off {
        (message.category.daily_limit() / 2).max(1)
    } else {
        message.category.daily_limit()
    };
    if used >= category_limit as i64 {
        return Ok(None);
    }
    let changed = tx
        .execute(
            "UPDATE soul_proactive_ledger SET state='dispatching', dispatching_at=?2 WHERE id=?1 AND state='pending'",
            params![&message.id, clock.unix_now],
        )
        .map_err(|_| crate::error_codes::LEDGER_UNREADABLE.to_string())?;
    if changed != 1 {
        return Ok(None);
    }
    total_used += 1;
    category_used[&name] = json!(used + 1);
    high_water = clock.unix_now.max(high_water);
    tx.execute(
        "INSERT INTO soul_quota(singleton,local_date,timezone,high_water_at,reset_not_before,total_used,category_used,last_dispatch_at)
         VALUES(1,?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(singleton) DO UPDATE SET
           local_date=?1, timezone=?2, high_water_at=?3, reset_not_before=?4, total_used=?5, category_used=?6, last_dispatch_at=?7",
        params![
            local_date,
            timezone,
            high_water,
            reset_not_before,
            total_used,
            category_used.to_string(),
            clock.unix_now
        ],
    )
    .map_err(|_| crate::error_codes::LEDGER_WRITE_FAILED.to_string())?;
    Ok(Some(()))
}

/// Pending entries outside their valid window can never revive; the sweep
/// records that deterministically instead of leaving stale rows behind.
pub fn expire_pending(conn: &mut Connection, unix_now: i64) -> Result<u64, String> {
    store::transaction(conn, |tx| {
        let changed = tx
            .execute(
                "UPDATE soul_proactive_ledger SET state='expired', receipt_at=?2
                 WHERE state='pending' AND expires_at<=?1",
                params![unix_now, unix_now],
            )
            .map_err(|_| crate::error_codes::LEDGER_UNREADABLE.to_string())?;
        Ok(u64::try_from(changed).unwrap_or(0))
    })
}

/// Restart recovery: an unconfirmed dispatch flips to uncertain; it is never
/// re-queued and never resolved into a fabricated shown.
pub fn recover_restart(conn: &mut Connection, now: i64) -> Result<u64, String> {
    store::transaction(conn, |tx| {
        let changed = tx
            .execute(
                "UPDATE soul_proactive_ledger SET state='uncertain', receipt_at=?1 WHERE state='dispatching'",
                params![now],
            )
            .map_err(|_| crate::error_codes::LEDGER_UNREADABLE.to_string())?;
        tx.execute(
            "UPDATE soul_proactive_ledger SET state='revoked',receipt_at=?1 WHERE state='shown'",
            [now],
        )
        .map_err(|_| crate::error_codes::LEDGER_UNREADABLE)?;
        Ok(u64::try_from(changed).unwrap_or(0))
    })
}

/// Turning proactive delivery off revokes queued and visible messages at
/// once; nothing from the disabled period is ever shown later.
pub fn revoke_on_disable(conn: &mut Connection, now: i64) -> Result<u64, String> {
    store::transaction(conn, |tx| {
        let changed = tx
            .execute(
                "UPDATE soul_proactive_ledger SET state='revoked', receipt_at=?1
                 WHERE state IN ('pending','dispatching','shown')",
                params![now],
            )
            .map_err(|_| crate::error_codes::LEDGER_UNREADABLE.to_string())?;
        Ok(u64::try_from(changed).unwrap_or(0))
    })
}

/// Monotonic shown/hidden bookkeeping for the current process. The persisted
/// `visible_seconds` column is a best-effort record; ignore evidence is only
/// ever derived from this registry (S16 keeps its own counters).
#[derive(Default)]
pub struct ShownRegistry(pub Mutex<HashMap<String, Instant>>);

/// Bubble and system-notification receipts (S08). Hidden must never fabricate
/// a final state, late receipts cannot revive terminal rows, and visible time
/// is measured with the backend clock, ignoring what the UI reports.
pub fn acknowledge(
    conn: &mut Connection,
    registry: &ShownRegistry,
    receipt: &MessageReceipt,
    monotonic_now: Instant,
    now: i64,
) -> Result<(), String> {
    let mut shown = registry
        .0
        .lock()
        .map_err(|_| crate::error_codes::VISIBILITY_UNAVAILABLE)?;
    let visible = shown
        .get(&receipt.message_id)
        .map(|at| monotonic_now.saturating_duration_since(*at).as_secs())
        .unwrap_or(0)
        .min(i64::MAX as u64) as i64;
    store::transaction(conn, |tx| {
        let row: Option<(String, Option<i64>)> = tx
            .query_row(
                "SELECT state,shown_at FROM soul_proactive_ledger WHERE id=?1",
                params![&receipt.message_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|_| crate::error_codes::LEDGER_UNREADABLE.to_string())?;
        let Some((state, _shown_at)) = row else {
            return Err(crate::error_codes::MESSAGE_MISSING.into());
        };
        match receipt.kind {
            ReceiptKind::Shown => {
                if state != "dispatching" && state != "shown" {
                    return Err(crate::error_codes::RECEIPT_INVALID.into());
                }
                tx.execute(
                    "UPDATE soul_proactive_ledger SET state='shown', shown_at=?2 WHERE id=?1 AND state IN ('dispatching','shown')",
                    params![&receipt.message_id, now],
                )
                .map_err(|_| crate::error_codes::LEDGER_WRITE_FAILED.to_string())?;
                Ok(())
            }
            ReceiptKind::Hidden => {
                if state != "shown" {
                    if matches!(
                        state.as_str(),
                        "responded" | "dismissed" | "revoked" | "expired" | "ignored"
                    ) {
                        return Ok(());
                    }
                    return Err(crate::error_codes::RECEIPT_INVALID.into());
                }
                tx.execute(
                    "UPDATE soul_proactive_ledger SET visible_seconds=visible_seconds+?2 WHERE id=?1 AND state='shown'",
                    params![&receipt.message_id, visible],
                )
                .map_err(|_| crate::error_codes::LEDGER_WRITE_FAILED.to_string())?;
                Ok(())
            }
            ReceiptKind::Responded | ReceiptKind::Dismissed => {
                if state != "shown" {
                    return Err(crate::error_codes::RECEIPT_INVALID.into());
                }
                let terminal = serde_json::to_value(receipt.kind)
                    .ok()
                    .and_then(|value| value.as_str().map(|s| s.to_string()))
                    .ok_or_else(|| crate::error_codes::RECEIPT_INVALID.to_string())?;
                tx.execute(
                    "UPDATE soul_proactive_ledger SET state=?3, receipt_at=?4, visible_seconds=visible_seconds+?2 WHERE id=?1 AND state='shown'",
                    params![&receipt.message_id, visible, terminal, now],
                )
                .map_err(|_| crate::error_codes::LEDGER_WRITE_FAILED.to_string())?;
                if receipt.kind == ReceiptKind::Responded {
                    tx.execute("DELETE FROM soul_backoff WHERE category=(SELECT category FROM soul_proactive_ledger WHERE id=?1)",[&receipt.message_id]).map_err(|_| crate::error_codes::LEDGER_WRITE_FAILED)?;
                }
                Ok(())
            }
            ReceiptKind::DeliveryFailed => {
                if state != "dispatching" {
                    return Err(crate::error_codes::RECEIPT_INVALID.into());
                }
                tx.execute(
                    "UPDATE soul_proactive_ledger SET state='failed', receipt_at=?2 WHERE id=?1 AND state='dispatching'",
                    params![&receipt.message_id, now],
                )
                .map_err(|_| crate::error_codes::LEDGER_WRITE_FAILED.to_string())?;
                Ok(())
            }
        }
    })?;
    match receipt.kind {
        ReceiptKind::Shown => {
            shown
                .entry(receipt.message_id.clone())
                .or_insert(monotonic_now);
        }
        _ => {
            shown.remove(&receipt.message_id);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::soul::model::SourceRef;

    #[test]
    fn backoff_halves_category_quota_until_recovery_without_refunding_global_quota() {
        let mut conn = migrated();
        gate_on(&conn);
        let mut cooldown = cooldown_ready();
        store::transaction(&mut conn, |tx| {
            queue(
                tx,
                message("a", ProactiveCategory::Greeting, "a", 100, 100000),
                100,
            )
        })
        .unwrap();
        assert!(reserve(&mut conn, &mut cooldown, time(100, 0))
            .unwrap()
            .is_some());
        store::transaction(&mut conn, |tx| {
            queue(
                tx,
                message("b", ProactiveCategory::Greeting, "b", 100, 100000),
                100,
            )
        })
        .unwrap();
        conn.execute(
            "INSERT INTO soul_backoff VALUES('greeting',3,100,604900)",
            [],
        )
        .unwrap();
        assert!(reserve(&mut conn, &mut cooldown, time(14500, 14400))
            .unwrap()
            .is_none());
        conn.execute("UPDATE soul_backoff SET recover_after=14500", [])
            .unwrap();
        assert!(reserve(&mut conn, &mut cooldown, time(14500, 14400))
            .unwrap()
            .is_some());
        assert_eq!(
            conn.query_row("SELECT total_used FROM soul_quota", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }

    fn migrated() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        store::migrate(&mut conn).unwrap();
        conn
    }

    fn message(
        id: &str,
        category: ProactiveCategory,
        dedupe: &str,
        from: i64,
        to: i64,
    ) -> ProactiveMessage {
        ProactiveMessage {
            id: id.into(),
            category,
            source: SourceRef {
                kind: "test".into(),
                id: id.into(),
                revision: 1,
            },
            dedupe_key: dedupe.into(),
            template_id: "t".into(),
            valid_from: from,
            expires_at: to,
            state: DeliveryState::Pending,
        }
    }

    fn gate_on(conn: &Connection) {
        let settings: Vec<Value> = [
            ProactiveCategory::TaskUnresolved,
            ProactiveCategory::OpenLoop,
            ProactiveCategory::Greeting,
            ProactiveCategory::Milestone,
            ProactiveCategory::Pattern,
            ProactiveCategory::SmallTalk,
            ProactiveCategory::OutputFeedback,
        ]
        .iter()
        .map(|category| {
            json!({
                "category": category_name(*category),
                "enabled": true,
                "available": true,
                "enabled_since": 100,
                "daily_limit": category.daily_limit(),
            })
        })
        .collect();
        conn.execute(
            "INSERT OR REPLACE INTO soul_control(singleton,revision,enabled,paused,enabled_since,cleared_through,category_settings)
             VALUES(1,1,1,0,100,0,?1)",
            params![json!(settings).to_string()],
        )
        .unwrap();
    }

    fn time(unix_now: i64, seconds_elapsed: u64) -> DispatchClock {
        DispatchClock {
            unix_now,
            offset_seconds: 0,
            timezone: "Asia/Shanghai".into(),
            monotonic: Instant::now() + Duration::from_secs(seconds_elapsed),
        }
    }

    /// Cooldown baseline sits past the full cooldown window: reserve is never
    /// blocked by it unless a test explicitly parks the restart cooldown.
    fn cooldown_ready() -> Cooldown {
        let base = Instant::now()
            .checked_sub(Duration::from_secs(COOLDOWN_SECONDS as u64 + 1))
            .unwrap();
        Cooldown {
            baseline: Some(base),
        }
    }

    fn pending_count(conn: &Connection) -> usize {
        conn.query_row(
            "SELECT count(*) FROM soul_proactive_ledger WHERE state='pending'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap() as usize
    }

    fn enqueue(conn: &mut Connection, message: ProactiveMessage, now: i64) {
        let tx = conn.transaction().unwrap();
        queue(&tx, message, now).unwrap();
        tx.commit().unwrap();
    }

    #[test]
    fn same_moment_candidates_deliver_highest_priority_once() {
        let mut conn = migrated();
        gate_on(&conn);
        enqueue(
            &mut conn,
            message("a", ProactiveCategory::SmallTalk, "k-a", 100, 900),
            100,
        );
        enqueue(
            &mut conn,
            message("b", ProactiveCategory::TaskUnresolved, "k-b", 100, 900),
            100,
        );
        enqueue(
            &mut conn,
            message("c", ProactiveCategory::Greeting, "k-c", 100, 900),
            100,
        );
        let mut cooldown = cooldown_ready();
        let dispatched = reserve(&mut conn, &mut cooldown, time(150, 10))
            .unwrap()
            .unwrap();
        assert_eq!(dispatched.category, ProactiveCategory::TaskUnresolved);
        assert_eq!(pending_count(&conn), 2);
        // The identical monotonic moment is inside the armed cooldown.
        assert!(reserve(&mut conn, &mut cooldown, time(150, 10))
            .unwrap()
            .is_none());
    }

    #[test]
    fn expired_candidates_lose_their_slot_during_the_sweep() {
        let mut conn = migrated();
        gate_on(&conn);
        enqueue(
            &mut conn,
            message("a", ProactiveCategory::SmallTalk, "k-a", 100, 200),
            100,
        );
        let mut cooldown = cooldown_ready();
        assert!(reserve(&mut conn, &mut cooldown, time(300, 0))
            .unwrap()
            .is_none());
        assert_eq!(expire_pending(&mut conn, 300).unwrap(), 1);
        assert_eq!(
            conn.query_row("SELECT state FROM soul_proactive_ledger", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "expired"
        );
    }

    #[test]
    fn daily_and_category_limits_block_without_losing_pending() {
        let mut conn = migrated();
        gate_on(&conn);
        for index in 0..4 {
            enqueue(
                &mut conn,
                message(
                    &format!("t{index}"),
                    ProactiveCategory::TaskUnresolved,
                    &format!("k{index}"),
                    100,
                    900_000,
                ),
                100,
            );
        }
        let mut cooldown = cooldown_ready();
        for slot in 0..DAILY_LIMIT {
            let dispatched = reserve(&mut conn, &mut cooldown, time(150, 10_000 * slot as u64))
                .unwrap()
                .unwrap();
            assert_eq!(dispatched.category, ProactiveCategory::TaskUnresolved);
        }
        assert!(reserve(&mut conn, &mut cooldown, time(160, 50_000))
            .unwrap()
            .is_none());
        assert_eq!(pending_count(&conn), 1);
    }

    #[test]
    fn category_limit_blocks_only_that_category() {
        let mut conn = migrated();
        gate_on(&conn);
        enqueue(
            &mut conn,
            message("o1", ProactiveCategory::OpenLoop, "k1", 100, 900_000),
            100,
        );
        enqueue(
            &mut conn,
            message("o2", ProactiveCategory::OpenLoop, "k2", 100, 900_000),
            100,
        );
        let mut cooldown = cooldown_ready();
        assert!(reserve(&mut conn, &mut cooldown, time(150, 10_000))
            .unwrap()
            .is_some());
        assert!(reserve(&mut conn, &mut cooldown, time(160, 20_000))
            .unwrap()
            .is_none());
        assert_eq!(pending_count(&conn), 1);
    }

    #[test]
    fn rollback_and_timezone_shifts_never_renew_quota() {
        let mut conn = migrated();
        gate_on(&conn);
        enqueue(
            &mut conn,
            message("a", ProactiveCategory::TaskUnresolved, "k-a", 100, 900_000),
            100,
        );
        let mut cooldown = cooldown_ready();
        assert!(reserve(&mut conn, &mut cooldown, time(1_000, 10_000))
            .unwrap()
            .is_some());
        // The first delivery ends in a terminal failure; quota stays consumed.
        conn.execute("UPDATE soul_proactive_ledger SET state='failed'", [])
            .unwrap();
        // A wall clock stepping back dispatches nothing and changes nothing.
        assert!(reserve(&mut conn, &mut cooldown, time(500, 20_000))
            .unwrap()
            .is_none());
        assert_eq!(
            conn.query_row("SELECT total_used FROM soul_quota", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        // A far-east shift yielding the same or an earlier local day label
        // stays inside the persisted bucket.
        let mut shifted = time(1_300, 30_000);
        shifted.offset_seconds = -36_000;
        assert!(reserve(&mut conn, &mut cooldown, shifted)
            .unwrap()
            .is_none());
        // Next local day after the reset guard rolls exactly one fresh bucket.
        enqueue(
            &mut conn,
            message("b", ProactiveCategory::OpenLoop, "k-b", 100, 900_000),
            88_000,
        );
        assert!(
            reserve(&mut conn, &mut cooldown, time(1_000 + DAY + 100, 40_000))
                .unwrap()
                .is_some()
        );
        let (total, _category_used, reset_not_before) = quota_state(&conn);
        assert_eq!(total, 1);
        assert_eq!(reset_not_before, 1_000 + DAY);
    }

    fn quota_state(conn: &Connection) -> (i64, String, i64) {
        conn.query_row(
            "SELECT total_used,category_used,reset_not_before FROM soul_quota WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get::<_, String>(1)?, r.get(2)?)),
        )
        .unwrap()
    }

    #[test]
    fn dispatching_crash_becomes_uncertain_and_never_requeues() {
        let mut conn = migrated();
        gate_on(&conn);
        enqueue(
            &mut conn,
            message("a", ProactiveCategory::TaskUnresolved, "k-a", 100, 900_000),
            100,
        );
        let mut cooldown = cooldown_ready();
        reserve(&mut conn, &mut cooldown, time(150, 10_000)).unwrap();
        assert_eq!(recover_restart(&mut conn, 200).unwrap(), 1);
        assert_eq!(
            conn.query_row("SELECT state FROM soul_proactive_ledger", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "uncertain"
        );
        // The spent dedupe identity cannot earn a retry, fresh ones can.
        enqueue(
            &mut conn,
            message("b", ProactiveCategory::TaskUnresolved, "k-a", 100, 900_000),
            200,
        );
        enqueue(
            &mut conn,
            message("c", ProactiveCategory::TaskUnresolved, "k-c", 200, 900_000),
            200,
        );
        assert_eq!(pending_count(&conn), 1);
        let mut fresh = cooldown_ready();
        assert!(reserve(&mut conn, &mut fresh, time(250, 10_000))
            .unwrap()
            .is_some());
        assert_eq!(pending_count(&conn), 0);
    }

    #[test]
    fn failed_delivery_keeps_consumed_quota_and_identity() {
        let mut conn = migrated();
        gate_on(&conn);
        enqueue(
            &mut conn,
            message("a", ProactiveCategory::TaskUnresolved, "k-a", 100, 900_000),
            100,
        );
        let mut cooldown = cooldown_ready();
        assert!(reserve(&mut conn, &mut cooldown, time(150, 10_000))
            .unwrap()
            .is_some());
        conn.execute("UPDATE soul_proactive_ledger SET state='failed'", [])
            .unwrap();
        assert_eq!(
            conn.query_row("SELECT total_used FROM soul_quota", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        // The dedupe key is still owned by the failed message.
        let duplicate = conn.execute(
            "INSERT INTO soul_proactive_ledger(id,category,source_ref,dedupe_key,template_id,valid_from,expires_at,state,created_at)
             VALUES('retry','task_unresolved','{}','k-a','t',100,900000,'pending',100)",
            [],
        );
        assert!(duplicate.is_err());
        assert_eq!(pending_count(&conn), 0);
    }

    #[test]
    fn pause_disable_and_missing_control_fail_closed() {
        let mut conn = migrated();
        gate_on(&conn);
        enqueue(
            &mut conn,
            message("a", ProactiveCategory::TaskUnresolved, "k-a", 100, 900_000),
            100,
        );
        let mut cooldown = cooldown_ready();
        conn.execute("UPDATE soul_control SET paused=1", [])
            .unwrap();
        assert!(reserve(&mut conn, &mut cooldown, time(150, 10_000))
            .unwrap()
            .is_none());
        conn.execute("UPDATE soul_control SET paused=0, enabled=0", [])
            .unwrap();
        assert!(reserve(&mut conn, &mut cooldown, time(150, 20_000))
            .unwrap()
            .is_none());
        assert_eq!(pending_count(&conn), 1);
        // Without any control record the kernel stays silent.
        let bare_mut = migrated();
        let mut bare = bare_mut;
        enqueue(
            &mut bare,
            message("b", ProactiveCategory::TaskUnresolved, "k-b", 100, 900_000),
            100,
        );
        let mut bare_cooldown = cooldown_ready();
        assert!(reserve(&mut bare, &mut bare_cooldown, time(150, 10_000))
            .unwrap()
            .is_none());
        assert_eq!(pending_count(&bare), 1);
    }

    #[test]
    fn parked_restart_cooldown_blocks_even_ready_quota() {
        let mut conn = migrated();
        gate_on(&conn);
        enqueue(
            &mut conn,
            message("a", ProactiveCategory::TaskUnresolved, "k-a", 100, 900_000),
            100,
        );
        let later = Instant::now() + Duration::from_secs(600);
        let mut parked = Cooldown::parked(Instant::now());
        // Well within the 2h restart cooldown.
        assert!(!parked.ready(later));
        assert!(reserve(&mut conn, &mut parked, time(150, 600))
            .unwrap()
            .is_none());
        assert_eq!(pending_count(&conn), 1);
        // After the restart cooldown the same message can deliver.
        let much_later = Instant::now() + Duration::from_secs(COOLDOWN_SECONDS as u64 + 600);
        assert!(parked.ready(much_later));
        let clock = DispatchClock {
            unix_now: 150,
            offset_seconds: 0,
            timezone: "Asia/Shanghai".into(),
            monotonic: much_later,
        };
        assert!(reserve(&mut conn, &mut parked, clock).unwrap().is_some());
    }

    // ---------- S08 receipts ----------

    fn dispatch_one(dedupe: &str) -> (Connection, ShownRegistry) {
        let mut conn = migrated();
        gate_on(&conn);
        enqueue(
            &mut conn,
            message("m", ProactiveCategory::TaskUnresolved, dedupe, 100, 900_000),
            100,
        );
        let mut cooldown = cooldown_ready();
        reserve(&mut conn, &mut cooldown, time(150, 10_000)).unwrap();
        (conn, ShownRegistry::default())
    }

    fn state_of(conn: &Connection, id: &str) -> String {
        conn.query_row(
            "SELECT state FROM soul_proactive_ledger WHERE id=?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn visible_of(conn: &Connection, id: &str) -> i64 {
        conn.query_row(
            "SELECT visible_seconds FROM soul_proactive_ledger WHERE id=?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn receipt(kind: ReceiptKind, seconds: u32) -> MessageReceipt {
        MessageReceipt {
            message_id: "m".into(),
            kind,
            visible_seconds: seconds,
        }
    }

    #[test]
    fn shown_hidden_responded_follow_the_monotonic_clock() {
        let (mut conn, registry) = dispatch_one("k-1");
        acknowledge(
            &mut conn,
            &registry,
            &receipt(ReceiptKind::Shown, 99),
            Instant::now(),
            300,
        )
        .unwrap();
        assert_eq!(state_of(&conn, "m"), "shown");
        // A claimed total visible duration from the UI is never trusted: the
        // backend monotonic registry decides how long the message was shown.
        registry
            .0
            .lock()
            .unwrap()
            .insert("m".into(), Instant::now() - Duration::from_secs(25));
        acknowledge(
            &mut conn,
            &registry,
            &receipt(ReceiptKind::Hidden, 5),
            Instant::now(),
            350,
        )
        .unwrap();
        // Hidden only resets the continuous timer; the state stays shown.
        assert_eq!(state_of(&conn, "m"), "shown");
        assert_eq!(visible_of(&conn, "m"), 25);
        acknowledge(
            &mut conn,
            &registry,
            &receipt(ReceiptKind::Responded, 30),
            Instant::now(),
            400,
        )
        .unwrap();
        assert_eq!(state_of(&conn, "m"), "responded");
    }

    #[test]
    fn late_and_out_of_order_receipts_cannot_fabricate_state() {
        let (mut conn, registry) = dispatch_one("k-2");
        assert_eq!(
            acknowledge(
                &mut conn,
                &registry,
                &receipt(ReceiptKind::Hidden, 3),
                Instant::now(),
                200
            )
            .unwrap_err(),
            crate::error_codes::RECEIPT_INVALID
        );
        acknowledge(
            &mut conn,
            &registry,
            &receipt(ReceiptKind::Shown, 0),
            Instant::now(),
            250,
        )
        .unwrap();
        acknowledge(
            &mut conn,
            &registry,
            &receipt(ReceiptKind::Responded, 0),
            Instant::now(),
            300,
        )
        .unwrap();
        // Terminal states cannot be revived or re-dispatched.
        assert_eq!(
            acknowledge(
                &mut conn,
                &registry,
                &receipt(ReceiptKind::Shown, 0),
                Instant::now(),
                350
            )
            .unwrap_err(),
            crate::error_codes::RECEIPT_INVALID
        );
        // Unknown message ids are distinct from storage failures.
        assert_eq!(
            acknowledge(
                &mut conn,
                &registry,
                &MessageReceipt {
                    message_id: "ghost".into(),
                    kind: ReceiptKind::Shown,
                    visible_seconds: 0
                },
                Instant::now(),
                350
            )
            .unwrap_err(),
            crate::error_codes::MESSAGE_MISSING
        );
    }

    #[test]
    fn delivery_failure_is_a_terminal_dispatch_outcome() {
        let (mut conn, registry) = dispatch_one("k-3");
        acknowledge(
            &mut conn,
            &registry,
            &receipt(ReceiptKind::DeliveryFailed, 0),
            Instant::now(),
            300,
        )
        .unwrap();
        assert_eq!(state_of(&conn, "m"), "failed");
        // Failed dispatch does not refund consumed quota.
        assert_eq!(
            conn.query_row("SELECT total_used FROM soul_quota", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}

/// Producers drop events that happened while their switch was off. A later
/// toggle must never turn those events into a backlog.
pub fn event_allowed(
    tx: &Transaction<'_>,
    category: ProactiveCategory,
    event_at: i64,
) -> Result<bool, String> {
    let row:Option<(bool,bool,i64,String)>=tx.query_row("SELECT enabled,paused,enabled_since,category_settings FROM soul_control WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(|_| crate::error_codes::LEDGER_UNREADABLE)?;
    let Some((enabled, paused, baseline, raw)) = row else {
        return Ok(false);
    };
    if !enabled || paused || event_at < baseline {
        return Ok(false);
    }
    let name = category_name(category);
    let category_baseline: i64 = tx
        .query_row(
            "SELECT enabled_since FROM soul_category_baselines WHERE category=?1",
            [&name],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| crate::error_codes::LEDGER_UNREADABLE)?
        .unwrap_or(0);
    let cleared: i64 = tx
        .query_row(
            "SELECT cleared_through FROM soul_domain_baselines WHERE domain='proactive'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| crate::error_codes::LEDGER_UNREADABLE)?
        .unwrap_or(0);
    if event_at < category_baseline || event_at <= cleared {
        return Ok(false);
    }
    let categories: Vec<Value> =
        serde_json::from_str(&raw).map_err(|_| crate::error_codes::LEDGER_UNREADABLE)?;
    let name = serde_json::to_value(category).map_err(|_| crate::error_codes::INVALID_CATEGORY)?;
    Ok(categories
        .iter()
        .any(|item| item["category"] == name && item["enabled"].as_bool() == Some(true)))
}

/// Only a continuous backend-timed visible interval counts as ignored.
pub fn expire_visible(
    conn: &mut Connection,
    registry: &ShownRegistry,
    now: i64,
    monotonic: Instant,
) -> Result<usize, String> {
    let mut shown = registry
        .0
        .lock()
        .map_err(|_| crate::error_codes::LEDGER_UNREADABLE)?;
    let due: Vec<String> = shown
        .iter()
        .filter(|(_, at)| monotonic.saturating_duration_since(**at) >= Duration::from_secs(20))
        .map(|(id, _)| id.clone())
        .collect();
    store::transaction(conn, |tx| {
        for id in &due {
            let category: Option<String> = tx
                .query_row(
                    "SELECT category FROM soul_proactive_ledger WHERE id=?1 AND state='shown'",
                    [id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|_| crate::error_codes::LEDGER_UNREADABLE)?;
            if let Some(category) = category {
                tx.execute("UPDATE soul_proactive_ledger SET state='ignored',receipt_at=?2,visible_seconds=visible_seconds+20 WHERE id=?1 AND state='shown'",params![id,now]).map_err(|_| crate::error_codes::LEDGER_WRITE_FAILED)?;
                tx.execute("INSERT INTO soul_backoff(category,consecutive_ignored,last_ignored_at,recover_after) VALUES(?1,1,?2,?3) ON CONFLICT(category) DO UPDATE SET consecutive_ignored=CASE WHEN recover_after<=?2 THEN 1 ELSE consecutive_ignored+1 END,last_ignored_at=?2,recover_after=?3",params![category,now,now+7*DAY]).map_err(|_| crate::error_codes::LEDGER_WRITE_FAILED)?;
            }
        }
        Ok(())
    })?;
    for id in &due {
        shown.remove(id);
    }
    Ok(due.len())
}

#[cfg(test)]
mod ignore_tests {
    use super::*;
    fn setup() -> (Connection, ShownRegistry, Instant) {
        let mut conn = Connection::open_in_memory().unwrap();
        store::migrate(&mut conn).unwrap();
        (conn, ShownRegistry::default(), Instant::now())
    }
    fn seed(conn: &Connection, registry: &ShownRegistry, id: &str, at: Instant) {
        conn.execute("INSERT INTO soul_proactive_ledger(id,category,source_ref,dedupe_key,template_id,valid_from,expires_at,state,created_at) VALUES(?1,'greeting','{}',?1,'hello',0,9999999,'shown',0)",[id]).unwrap();
        registry.0.lock().unwrap().insert(id.into(), at);
    }
    #[test]
    fn receipt_write_failure_keeps_registry_consistent_with_disk() {
        let (mut conn, registry, at) = setup();
        seed(&conn, &registry, "one", at);
        conn.execute_batch("CREATE TRIGGER fail_receipt BEFORE UPDATE ON soul_proactive_ledger BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
        assert!(acknowledge(
            &mut conn,
            &registry,
            &MessageReceipt {
                message_id: "one".into(),
                kind: ReceiptKind::Hidden,
                visible_seconds: 0
            },
            at + Duration::from_secs(5),
            105
        )
        .is_err());
        assert!(registry.0.lock().unwrap().contains_key("one"));
        conn.execute_batch(
            "DROP TRIGGER fail_receipt; UPDATE soul_proactive_ledger SET state='dispatching';",
        )
        .unwrap();
        registry.0.lock().unwrap().clear();
        conn.execute_batch("CREATE TRIGGER fail_receipt BEFORE UPDATE ON soul_proactive_ledger BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
        assert!(acknowledge(
            &mut conn,
            &registry,
            &MessageReceipt {
                message_id: "one".into(),
                kind: ReceiptKind::Shown,
                visible_seconds: 0
            },
            at,
            100
        )
        .is_err());
        assert!(registry.0.lock().unwrap().is_empty());
    }
    #[test]
    fn twenty_seconds_must_be_continuous_and_ignore_is_idempotent() {
        let (mut conn, registry, at) = setup();
        seed(&conn, &registry, "one", at);
        assert_eq!(
            expire_visible(&mut conn, &registry, 100, at + Duration::from_secs(19)).unwrap(),
            0
        );
        acknowledge(
            &mut conn,
            &registry,
            &MessageReceipt {
                message_id: "one".into(),
                kind: ReceiptKind::Hidden,
                visible_seconds: 999,
            },
            at + Duration::from_secs(19),
            101,
        )
        .unwrap();
        assert_eq!(
            expire_visible(&mut conn, &registry, 200, at + Duration::from_secs(200)).unwrap(),
            0
        );
        acknowledge(
            &mut conn,
            &registry,
            &MessageReceipt {
                message_id: "one".into(),
                kind: ReceiptKind::Shown,
                visible_seconds: 999,
            },
            at + Duration::from_secs(201),
            201,
        )
        .unwrap();
        assert_eq!(
            expire_visible(&mut conn, &registry, 220, at + Duration::from_secs(220)).unwrap(),
            0
        );
        assert_eq!(
            expire_visible(&mut conn, &registry, 221, at + Duration::from_secs(221)).unwrap(),
            1
        );
        assert_eq!(
            expire_visible(&mut conn, &registry, 222, at + Duration::from_secs(222)).unwrap(),
            0
        );
        let row: (String, i64) = conn
            .query_row(
                "SELECT state,visible_seconds FROM soul_proactive_ledger WHERE id='one'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(row, ("ignored".into(), 39));
    }
    #[test]
    fn write_failure_keeps_timer_and_does_not_spend_ignore() {
        let (mut conn, registry, at) = setup();
        seed(&conn, &registry, "one", at);
        conn.execute_batch("CREATE TRIGGER fail_ignore BEFORE INSERT ON soul_backoff BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
        assert!(expire_visible(&mut conn, &registry, 100, at + Duration::from_secs(20)).is_err());
        assert!(registry.0.lock().unwrap().contains_key("one"));
        assert_eq!(
            conn.query_row("SELECT state FROM soul_proactive_ledger", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "shown"
        );
        conn.execute_batch("DROP TRIGGER fail_ignore").unwrap();
        assert_eq!(
            expire_visible(&mut conn, &registry, 101, at + Duration::from_secs(21)).unwrap(),
            1
        );
    }
    #[test]
    fn three_ignores_persist_and_response_or_seven_days_restore_category() {
        let (mut conn, registry, at) = setup();
        for i in 0..3 {
            seed(&conn, &registry, &format!("m{i}"), at);
            expire_visible(&mut conn, &registry, 100 + i, at + Duration::from_secs(20)).unwrap();
        }
        assert_eq!(
            conn.query_row("SELECT consecutive_ignored FROM soul_backoff", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            3
        );
        seed(&conn, &registry, "reply", at);
        acknowledge(
            &mut conn,
            &registry,
            &MessageReceipt {
                message_id: "reply".into(),
                kind: ReceiptKind::Responded,
                visible_seconds: 0,
            },
            at,
            200,
        )
        .unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM soul_backoff", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        seed(&conn, &registry, "later", at);
        expire_visible(&mut conn, &registry, 300, at + Duration::from_secs(20)).unwrap();
        seed(&conn, &registry, "week", at);
        expire_visible(
            &mut conn,
            &registry,
            300 + 7 * DAY,
            at + Duration::from_secs(20),
        )
        .unwrap();
        assert_eq!(
            conn.query_row("SELECT consecutive_ignored FROM soul_backoff", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}
