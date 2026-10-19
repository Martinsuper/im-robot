use super::model::{RoleProfile, MAX_ACTIVE_LOOPS, SCHEMA_VERSION};
use rusqlite::{params, Connection, OptionalExtension, Transaction};

/// Soul migrations are independent of legacy memory migrations. A failed
/// migration rolls back and must never trigger the legacy in-memory fallback.
pub fn migrate(conn: &mut Connection) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS soul_schema (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL);",
    )
    .map_err(|e| e.to_string())?;
    let version: i64 = tx
        .query_row(
            "SELECT version FROM soul_schema WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(0);
    if version > SCHEMA_VERSION {
        return Err("Soul schema is newer than this application".into());
    }
    if version < 1 {
        tx.execute_batch(
            &include_str!("schema_v1.sql")
                .replace("__MAX_ACTIVE_LOOPS__", &MAX_ACTIVE_LOOPS.to_string()),
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO soul_schema(singleton,version) VALUES(1,?1)",
            [SCHEMA_VERSION],
        )
        .map_err(|e| e.to_string())?;
    }
    if version < 2 {
        tx.execute_batch(include_str!("schema_v2.sql"))
            .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE soul_schema SET version=?1 WHERE singleton=1",
            [SCHEMA_VERSION],
        )
        .map_err(|e| e.to_string())?;
    }
    if version < 3 {
        tx.execute_batch(include_str!("schema_v3.sql"))
            .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE soul_schema SET version=?1 WHERE singleton=1",
            [SCHEMA_VERSION],
        )
        .map_err(|e| e.to_string())?;
    }
    if version < 4 {
        tx.execute_batch(include_str!("schema_v4.sql"))
            .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE soul_schema SET version=?1 WHERE singleton=1",
            [SCHEMA_VERSION],
        )
        .map_err(|e| e.to_string())?;
    }
    if version < 5 {
        tx.execute_batch(include_str!("schema_v5.sql"))
            .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE soul_schema SET version=?1 WHERE singleton=1",
            [SCHEMA_VERSION],
        )
        .map_err(|e| e.to_string())?;
    }
    if version < 6 {
        tx.execute_batch(include_str!("schema_v6.sql"))
            .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE soul_schema SET version=?1 WHERE singleton=1",
            [SCHEMA_VERSION],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

/// Fail closed on missing, incompatible or unreadable soul state.
pub fn ensure_available(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row(
            "SELECT version FROM soul_schema WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if version != SCHEMA_VERSION {
        return Err("Soul storage unavailable".into());
    }
    Ok(())
}

pub fn transaction<T>(
    conn: &mut Connection,
    write: impl FnOnce(&Transaction<'_>) -> Result<T, String>,
) -> Result<T, String> {
    ensure_available(conn)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let result = write(&tx)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

/// A corrupt profile is reported separately from database errors so S02 can
/// fall back to built-in resources without treating an unreadable ledger as empty.
pub fn read_profile(conn: &Connection, id: &str) -> Result<Option<RoleProfile>, String> {
    ensure_available(conn)?;
    let row: Option<(i64, String, String, String, i64)> = conn.query_row(
        "SELECT revision,default_resource_version,user_overrides,confirmed_evolution,updated_at FROM soul_profiles WHERE profile_id=?1",
        [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)))
        .optional().map_err(|e| e.to_string())?;
    row.map(
        |(revision, default_resource_version, overrides, evolution, updated_at)| {
            let user_overrides =
                serde_json::from_str(&overrides).map_err(|_| "Soul profile corrupt".to_string())?;
            let confirmed_evolution =
                serde_json::from_str(&evolution).map_err(|_| "Soul profile corrupt".to_string())?;
            if !serde_json::Value::is_object(&user_overrides)
                || !serde_json::Value::is_object(&confirmed_evolution)
            {
                return Err("Soul profile corrupt".into());
            }
            Ok(RoleProfile {
                profile_id: id.into(),
                schema_version: SCHEMA_VERSION,
                revision,
                default_resource_version,
                user_overrides,
                confirmed_evolution,
                updated_at,
            })
        },
    )
    .transpose()
}

/// expected_revision=0 creates; every committed change increments exactly once.
pub fn save_profile(
    conn: &mut Connection,
    profile: &RoleProfile,
    expected_revision: i64,
) -> Result<i64, String> {
    if profile.schema_version != SCHEMA_VERSION
        || profile.profile_id.trim().is_empty()
        || expected_revision < 0
        || !profile.user_overrides.is_object()
        || !profile.confirmed_evolution.is_object()
    {
        return Err("Invalid soul profile".into());
    }
    let next = expected_revision
        .checked_add(1)
        .ok_or("Soul revision overflow")?;
    transaction(conn, |tx| {
        let changed = if expected_revision == 0 {
            tx.execute("INSERT INTO soul_profiles(profile_id,revision,default_resource_version,user_overrides,confirmed_evolution,updated_at) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(profile_id) DO NOTHING",
                params![profile.profile_id,next,profile.default_resource_version,profile.user_overrides.to_string(),profile.confirmed_evolution.to_string(),profile.updated_at])
        } else {
            tx.execute("UPDATE soul_profiles SET revision=?2,default_resource_version=?3,user_overrides=?4,confirmed_evolution=?5,updated_at=?6 WHERE profile_id=?1 AND revision=?7",
                params![profile.profile_id,next,profile.default_resource_version,profile.user_overrides.to_string(),profile.confirmed_evolution.to_string(),profile.updated_at,expected_revision])
        }.map_err(|e| e.to_string())?;
        if changed != 1 {
            return Err("Soul revision conflict".into());
        }
        Ok(next)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn profile() -> RoleProfile {
        RoleProfile {
            profile_id: "piko".into(),
            schema_version: SCHEMA_VERSION,
            revision: 0,
            default_resource_version: "1".into(),
            user_overrides: json!({}),
            confirmed_evolution: json!({}),
            updated_at: 100,
        }
    }

    #[test]
    fn migration_is_idempotent_and_preserves_legacy_data() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE memory_items(id TEXT); INSERT INTO memory_items VALUES('legacy');",
        )
        .unwrap();
        migrate(&mut conn).unwrap();
        save_profile(&mut conn, &profile(), 0).unwrap();
        migrate(&mut conn).unwrap();
        assert_eq!(read_profile(&conn, "piko").unwrap().unwrap().revision, 1);
        assert_eq!(
            conn.query_row("SELECT id FROM memory_items", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "legacy"
        );
        assert_eq!(
            conn.query_row("SELECT count(*) FROM soul_proactive_ledger", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn failed_migration_rolls_back_all_new_tables() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE soul_open_loops(original TEXT); INSERT INTO soul_open_loops VALUES('preserved');").unwrap();
        assert!(migrate(&mut conn).is_err());
        assert!(ensure_available(&conn).is_err());
        assert!(conn.prepare("SELECT * FROM soul_profiles").is_err());
        assert_eq!(
            conn.query_row("SELECT original FROM soul_open_loops", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "preserved"
        );
    }

    #[test]
    fn future_schema_is_not_downgraded() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE soul_schema(singleton INTEGER PRIMARY KEY,version INTEGER); INSERT INTO soul_schema VALUES(1,99);").unwrap();
        assert!(migrate(&mut conn).is_err());
        assert!(ensure_available(&conn).is_err());
        assert_eq!(
            conn.query_row("SELECT version FROM soul_schema", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            99
        );
    }

    #[test]
    fn stale_updates_and_failed_transactions_do_not_advance_revision() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        assert_eq!(save_profile(&mut conn, &profile(), 0).unwrap(), 1);
        assert!(save_profile(&mut conn, &profile(), 0).is_err());
        assert_eq!(save_profile(&mut conn, &profile(), 1).unwrap(), 2);
        assert!(save_profile(&mut conn, &profile(), 1).is_err());
        let result: Result<(), String> = transaction(&mut conn, |tx| {
            tx.execute("UPDATE soul_profiles SET revision=100", [])
                .unwrap();
            Err("simulated failure".into())
        });
        assert!(result.is_err());
        assert_eq!(read_profile(&conn, "piko").unwrap().unwrap().revision, 2);
    }

    #[test]
    fn invalid_profile_is_distinct_from_missing_profile_or_storage_failure() {
        let mut conn = Connection::open_in_memory().unwrap();
        assert!(read_profile(&conn, "piko").is_err());
        migrate(&mut conn).unwrap();
        assert!(read_profile(&conn, "piko").unwrap().is_none());
        save_profile(&mut conn, &profile(), 0).unwrap();
        conn.execute("UPDATE soul_profiles SET user_overrides='[]'", [])
            .unwrap();
        assert_eq!(
            read_profile(&conn, "piko").unwrap_err(),
            "Soul profile corrupt"
        );
    }

    #[test]
    fn commit_failure_is_reported_and_rolled_back() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);").unwrap();
        let result = transaction(&mut conn, |tx| {
            tx.execute("INSERT INTO child VALUES(42)", [])
                .map_err(|e| e.to_string())?;
            Ok(())
        });
        assert!(result.is_err());
        assert_eq!(
            conn.query_row("SELECT count(*) FROM child", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn persisted_profile_survives_reopen_and_repeated_migration() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("memory.db");
        {
            let mut conn = Connection::open(&path).unwrap();
            migrate(&mut conn).unwrap();
            save_profile(&mut conn, &profile(), 0).unwrap();
        }
        let mut conn = Connection::open(&path).unwrap();
        migrate(&mut conn).unwrap();
        assert_eq!(read_profile(&conn, "piko").unwrap().unwrap().revision, 1);
    }

    #[test]
    fn active_loop_limit_covers_insert_and_reactivation() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        let insert = "INSERT INTO soul_open_loops(id,revision,content,source_ref,time_baseline,timezone,parser_version,state,created_at,updated_at) VALUES(?1,1,'plan','{}',100,'Asia/Shanghai','1',?2,100,100)";
        conn.execute(insert, params!["closed", "closed"]).unwrap();
        for i in 0..MAX_ACTIVE_LOOPS {
            conn.execute(insert, params![i.to_string(), "tracking"])
                .unwrap();
        }
        assert!(conn.execute(insert, params!["overflow", "due"]).is_err());
        assert!(conn
            .execute(
                "UPDATE soul_open_loops SET state='tracking' WHERE id='closed'",
                []
            )
            .is_err());
        // An already-active item can change from tracking to due at capacity.
        conn.execute("UPDATE soul_open_loops SET state='due' WHERE id='0'", [])
            .unwrap();
        conn.execute("UPDATE soul_open_loops SET state='closed' WHERE id='0'", [])
            .unwrap();
        conn.execute(
            "UPDATE soul_open_loops SET state='tracking' WHERE id='closed'",
            [],
        )
        .unwrap();
    }

    #[test]
    fn ledger_deduplication_rolls_back_quota_reservation() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        conn.execute_batch(
            "INSERT INTO soul_quota VALUES(1,'2026-10-16','Asia/Shanghai',100,86500,1,'{}',100);",
        )
        .unwrap();
        let insert = "INSERT INTO soul_proactive_ledger(id,category,source_ref,dedupe_key,template_id,valid_from,expires_at,state,created_at) VALUES(?1,'task_unresolved','{}','task:1','task_failed',100,200,'dispatching',100)";
        conn.execute(insert, ["first"]).unwrap();
        let result = transaction(&mut conn, |tx| {
            tx.execute("UPDATE soul_quota SET total_used=total_used+1", [])
                .map_err(|e| e.to_string())?;
            tx.execute(insert, ["duplicate"])
                .map_err(|e| e.to_string())?;
            Ok(())
        });
        assert!(result.is_err());
        assert_eq!(
            conn.query_row("SELECT total_used FROM soul_quota", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}

#[cfg(test)]
mod upgrade_tests {
    use super::*;
    #[test]
    fn upgrade_from_v1_keeps_profiles_and_spent_quota() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&include_str!("schema_v1.sql").replace("__MAX_ACTIVE_LOOPS__", "20"))
            .unwrap();
        conn.execute_batch("CREATE TABLE soul_schema(singleton INTEGER PRIMARY KEY,version INTEGER); INSERT INTO soul_schema VALUES(1,1); INSERT INTO soul_profiles VALUES('piko',7,'1','{}','{}',100); INSERT INTO soul_quota VALUES(1,'2026-10-17','Asia/Shanghai',100,86500,2,'{\"greeting\":2}',100);").unwrap();
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();
        assert_eq!(read_profile(&conn, "piko").unwrap().unwrap().revision, 7);
        assert_eq!(
            conn.query_row("SELECT total_used FROM soul_quota", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert!(conn.prepare("SELECT * FROM soul_task_followups").is_ok());
    }
}
