use super::{model::*, profile, store};
use rusqlite::{Connection, OptionalExtension};

/// Validate persisted scheduler inputs without exposing payloads in diagnostics.
/// An unreadable ledger is never represented as an empty queue.
pub fn check_ledger(conn: &Connection) -> Result<(), String> {
    store::ensure_available(conn)?;
    let mut statement = conn.prepare("SELECT id,category,source_ref,dedupe_key,template_id,valid_from,expires_at,state,visible_seconds,dispatching_at FROM soul_proactive_ledger")
        .map_err(|_| crate::error_codes::LEDGER_UNREADABLE)?;
    let mut requires_quota = false;
    let mut rows = statement
        .query([])
        .map_err(|_| crate::error_codes::LEDGER_UNREADABLE)?;
    while let Some(row) = rows
        .next()
        .map_err(|_| crate::error_codes::LEDGER_UNREADABLE)?
    {
        let text = |index| {
            row.get::<_, String>(index)
                .map_err(|_| crate::error_codes::LEDGER_UNREADABLE.to_string())
        };
        let category = text(1)?;
        let state = text(7)?;
        serde_json::from_value::<ProactiveCategory>(serde_json::Value::String(category))
            .map_err(|_| crate::error_codes::LEDGER_UNREADABLE)?;
        let state = serde_json::from_value::<DeliveryState>(serde_json::Value::String(state))
            .map_err(|_| crate::error_codes::LEDGER_UNREADABLE)?;
        let dispatched: Option<i64> = row
            .get(9)
            .map_err(|_| crate::error_codes::LEDGER_UNREADABLE)?;
        requires_quota |= dispatched.is_some()
            || matches!(
                state,
                DeliveryState::Dispatching
                    | DeliveryState::Shown
                    | DeliveryState::Responded
                    | DeliveryState::Dismissed
                    | DeliveryState::Ignored
                    | DeliveryState::Uncertain
            );
        let source: SourceRef =
            serde_json::from_str(&text(2)?).map_err(|_| crate::error_codes::LEDGER_UNREADABLE)?;
        let starts: i64 = row
            .get(5)
            .map_err(|_| crate::error_codes::LEDGER_UNREADABLE)?;
        let expires: i64 = row
            .get(6)
            .map_err(|_| crate::error_codes::LEDGER_UNREADABLE)?;
        let visible: i64 = row
            .get(8)
            .map_err(|_| crate::error_codes::LEDGER_UNREADABLE)?;
        if text(0)?.is_empty()
            || text(3)?.is_empty()
            || text(4)?.is_empty()
            || source.id.is_empty()
            || source.kind.is_empty()
            || source.revision < 0
            || expires <= starts
            || visible < 0
        {
            return Err(crate::error_codes::LEDGER_UNREADABLE.into());
        }
    }
    let quota: Option<(i64, String, i64, i64, String)> = conn.query_row(
        "SELECT total_used,category_used,high_water_at,reset_not_before,local_date FROM soul_quota WHERE singleton=1", [],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))
        .optional().map_err(|_| crate::error_codes::QUOTA_UNREADABLE)?;
    if requires_quota && quota.is_none() {
        return Err(crate::error_codes::QUOTA_UNREADABLE.into());
    }
    if let Some((used, categories, high_water, reset_after, date)) = quota {
        let counts: std::collections::HashMap<ProactiveCategory, u32> =
            serde_json::from_str(&categories).map_err(|_| crate::error_codes::QUOTA_UNREADABLE)?;
        let sum = counts.values().map(|v| u64::from(*v)).sum::<u64>();
        if used < 0
            || sum != used as u64
            || reset_after < 0
            || high_water < 0
            || chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").is_err()
        {
            return Err(crate::error_codes::QUOTA_UNREADABLE.into());
        }
    }
    Ok(())
}

pub fn inspect(conn: &Connection, boot_ok: bool) -> SoulDiagnostics {
    let persistent = conn
        .query_row(
            "SELECT file FROM pragma_database_list WHERE name='main'",
            [],
            |row| row.get::<_, String>(0),
        )
        .is_ok_and(|path| !path.is_empty());
    let version = conn
        .query_row(
            "SELECT version FROM soul_schema WHERE singleton=1",
            [],
            |r| r.get::<_, i64>(0),
        )
        .ok();
    let storage_ok = boot_ok && persistent && store::ensure_available(conn).is_ok();
    let profile_ok = storage_ok
        && match store::read_profile(conn, profile::PROFILE_ID) {
            Ok(Some(profile)) => profile::validated_layers(&profile).is_ok(),
            Ok(None) => true,
            Err(_) => false,
        };
    let ledger_ok = storage_ok && check_ledger(conn).is_ok();
    let mut issues = Vec::new();
    if !persistent {
        issues.push("volatile_storage".into());
    }
    if !boot_ok || !storage_ok {
        issues.push(crate::error_codes::STORAGE_UNAVAILABLE.into());
    }
    if storage_ok && !profile_ok {
        issues.push(crate::error_codes::PROFILE_CORRUPT.into());
    }
    if storage_ok && !ledger_ok {
        issues.push(crate::error_codes::LEDGER_UNREADABLE.into());
    }
    SoulDiagnostics {
        storage: if !persistent {
            SoulStorageState::Volatile
        } else if storage_ok {
            SoulStorageState::Available
        } else {
            SoulStorageState::Unavailable
        },
        schema_version: version,
        profile_valid: profile_ok,
        ledger_readable: ledger_ok,
        // S12 is the rollout gate; no settings row can bypass it.
        proactive_enabled: storage_ok
            && ledger_ok
            && conn
                .query_row(
                    "SELECT enabled=1 AND paused=0 FROM soul_control WHERE singleton=1",
                    [],
                    |row| row.get::<_, bool>(0),
                )
                .unwrap_or(false),
        issues,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volatile_or_failed_boot_cannot_be_reported_as_available() {
        let mut conn = Connection::open_in_memory().unwrap();
        store::migrate(&mut conn).unwrap();
        let result = inspect(&conn, true);
        assert!(matches!(result.storage, SoulStorageState::Volatile));
        assert!(!result.ledger_readable);
        assert!(!result.proactive_enabled);
        let dir = tempfile::tempdir().unwrap();
        let mut conn = Connection::open(dir.path().join("memory.db")).unwrap();
        store::migrate(&mut conn).unwrap();
        assert!(matches!(
            inspect(&conn, false).storage,
            SoulStorageState::Unavailable
        ));
        assert!(matches!(
            inspect(&conn, true).storage,
            SoulStorageState::Available
        ));
    }

    #[test]
    fn corrupt_ledger_or_quota_stops_delivery_without_erasing_rows() {
        let mut conn = Connection::open_in_memory().unwrap();
        store::migrate(&mut conn).unwrap();
        assert!(check_ledger(&conn).is_ok());
        conn.execute_batch("INSERT INTO soul_proactive_ledger(id,category,source_ref,dedupe_key,template_id,valid_from,expires_at,state,created_at) VALUES('one','greeting','{}','event:1','hello',100,200,'pending',100);").unwrap();
        assert!(check_ledger(&conn).is_err());
        conn.execute(
            "UPDATE soul_proactive_ledger SET source_ref=?1",
            [r#"{"kind":"app_event","id":"event:1","revision":1}"#],
        )
        .unwrap();
        assert!(check_ledger(&conn).is_ok());
        conn.execute_batch(
            "INSERT INTO soul_quota VALUES(1,'2026-10-16','Asia/Shanghai',100,86500,1,'[]',100);",
        )
        .unwrap();
        assert!(check_ledger(&conn).is_err());
        assert_eq!(
            conn.query_row("SELECT count(*) FROM soul_proactive_ledger", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn diagnostics_do_not_expose_corrupt_profile_content() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = Connection::open(dir.path().join("memory.db")).unwrap();
        store::migrate(&mut conn).unwrap();
        profile::load_or_create(&mut conn, "en-US", 100).unwrap();
        conn.execute(
            "UPDATE soul_profiles SET user_overrides='{\"private-body\":\"secret-value\"}'",
            [],
        )
        .unwrap();
        let result = inspect(&conn, true);
        assert!(!result.profile_valid);
        assert!(result.ledger_readable);
        let output = serde_json::to_string(&result).unwrap();
        assert!(output.contains(crate::error_codes::PROFILE_CORRUPT));
        assert!(!output.contains("private-body"));
        assert!(!output.contains("secret-value"));
    }
}

#[cfg(test)]
mod control_state_tests {
    use super::*;
    #[test]
    fn effective_control_tracks_pause_and_storage_health() {
        let directory = tempfile::tempdir().unwrap();
        let mut conn = Connection::open(directory.path().join("memory.db")).unwrap();
        store::migrate(&mut conn).unwrap();
        super::super::settings::get(&mut conn, 100).unwrap();
        assert!(!inspect(&conn, true).proactive_enabled);
        conn.execute("UPDATE soul_control SET enabled=1", [])
            .unwrap();
        assert!(inspect(&conn, true).proactive_enabled);
        assert!(!inspect(&conn, false).proactive_enabled);
        conn.execute("UPDATE soul_control SET paused=1", [])
            .unwrap();
        assert!(!inspect(&conn, true).proactive_enabled);
    }
}
