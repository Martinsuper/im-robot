//! S10/S11 backend: persisted switches (CAS), visibility capabilities, and
//! scoped clearing with enable-baseline bookkeeping. The client can only
//! toggle writable switches; limits and availability stay backend-owned.
use super::{model::*, store};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

/// Policy-level category facts (P1/P2 交付状态), never duplicated into UI.
fn category_policy() -> Vec<CategorySetting> {
    [
        ProactiveCategory::TaskUnresolved,
        ProactiveCategory::OpenLoop,
        ProactiveCategory::Greeting,
        ProactiveCategory::Milestone,
        ProactiveCategory::Pattern,
        ProactiveCategory::SmallTalk,
        ProactiveCategory::OutputFeedback,
    ]
    .iter()
    .map(|category| CategorySetting {
        category: *category,
        // The global switch remains opt-in; only task followups default on.
        enabled: *category == ProactiveCategory::TaskUnresolved,
        available: true,
        enabled_since: None,
        daily_limit: category.daily_limit(),
    })
    .collect()
}

fn enabled_map(raw: &str) -> Result<serde_json::Map<String, Value>, String> {
    let value: Vec<Value> =
        serde_json::from_str(raw).map_err(|_| "ledger_unreadable".to_string())?;
    let mut map = serde_json::Map::new();
    for entry in value {
        let name = entry
            .get("category")
            .and_then(Value::as_str)
            .ok_or("ledger_unreadable")?;
        let enabled = entry
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        map.insert(name.to_string(), json!(enabled));
    }
    Ok(map)
}

pub fn get(conn: &mut Connection, now: i64) -> Result<SoulSettings, String> {
    store::transaction(conn, |tx| {
        let row = tx
            .query_row(
                "SELECT revision,enabled,paused,enabled_since,category_settings FROM soul_control WHERE singleton=1",
                [],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, Option<i64>>(3)?,
                        r.get::<_, String>(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| "ledger_unreadable".to_string())?;
        let (revision, enabled, paused, enabled_since, category_settings) = match row {
            Some(values) => values,
            None => {
                // First open of the settings surfaces explicit defaults; the
                // global switch stays off until the user (or P0 rollout) turns
                // it on.
                let stored: Vec<Value> = category_policy()
                    .iter()
                    .map(|category| {
                        json!({
                            "category": serde_json::to_value(category.category).unwrap(),
                            "enabled": category.enabled,
                        })
                    })
                    .collect();
                let stored_json =
                    serde_json::to_string(&stored).map_err(|_| "invalid_settings".to_string())?;
                tx.execute(
                    "INSERT INTO soul_control(singleton,revision,enabled,paused,enabled_since,cleared_through,category_settings)
                     VALUES(1,1,0,0,?1,0,?2)",
                    rusqlite::params![now, stored_json],
                )
                .map_err(|_| "ledger_write_failed".to_string())?;
                (1, 0, 0, Some(now), stored_json)
            }
        };
        let stored = enabled_map(&category_settings)?;
        let mut categories = Vec::new();
        for policy in category_policy() {
            let name = serde_json::to_value(policy.category).unwrap();
            let enabled = stored
                .get(name.as_str().unwrap())
                .and_then(Value::as_bool)
                .unwrap_or(policy.enabled);
            let enabled_since=tx.query_row("SELECT enabled_since FROM soul_category_baselines WHERE category=?1",[name.as_str().unwrap()],|r|r.get::<_,i64>(0)).optional().map_err(|_| "ledger_unreadable")?;
            categories.push(CategorySetting { enabled, enabled_since, ..policy });
        }
        let (mood_enabled, evolution_enabled) = tx.query_row(
            "SELECT mood_enabled,evolution_enabled FROM soul_control WHERE singleton=1", [],
            |row| Ok((row.get::<_, bool>(0)?, row.get::<_, bool>(1)?)),
        ).map_err(|_| "ledger_unreadable")?;
        Ok(SoulSettings {
            revision,
            enabled: enabled == 1,
            paused: paused == 1,
            enabled_since,
            categories,
            mood_enabled,
            evolution_enabled,
            daily_limit: DAILY_LIMIT,
            cooldown_seconds: COOLDOWN_SECONDS,
        })
    })
}

pub fn update(
    conn: &mut Connection,
    input: &UpdateSoulSettingsInput,
    now: i64,
) -> Result<(), String> {
    store::transaction(conn, |tx| {
        let row = tx
            .query_row(
                "SELECT revision,enabled,paused,enabled_since,category_settings FROM soul_control WHERE singleton=1",
                [],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, Option<i64>>(3)?,
                        r.get::<_, String>(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| "ledger_unreadable".to_string())?;
        let Some((revision, enabled_old, paused_old, enabled_since_old, category_settings)) = row
        else {
            return Err("control_missing".into());
        };
        if input.expected_revision != revision {
            return Err("revision_conflict".into());
        }
        let enabled_old = enabled_old == 1;
        let paused_old = paused_old == 1;
        let enabled = input.enabled.unwrap_or(enabled_old);
        let paused = input.paused.unwrap_or(paused_old);
        let mut stored = enabled_map(&category_settings)?;
        if let Some(toggles) = &input.categories {
            for toggle in toggles {
                let name = serde_json::to_value(toggle.category)
                    .ok()
                    .and_then(|value| value.as_str().map(|s| s.to_string()))
                    .ok_or("invalid_settings")?;
                let available = category_policy()
                    .iter()
                    .any(|policy| policy.category == toggle.category && policy.available);
                if !available {
                    return Err("capability_unavailable".into());
                }
                if toggle.enabled && stored.get(&name).and_then(Value::as_bool)!=Some(true) {
                    tx.execute("INSERT INTO soul_category_baselines VALUES(?1,?2) ON CONFLICT(category) DO UPDATE SET enabled_since=max(enabled_since,excluded.enabled_since)",rusqlite::params![name,now]).map_err(|_| "ledger_write_failed")?;
                }
                stored.insert(name, json!(toggle.enabled));
            }
        }
        if input.evolution_enabled == Some(true) {
            let was:bool=tx.query_row("SELECT evolution_enabled FROM soul_control WHERE singleton=1",[],|r|r.get(0)).map_err(|_|"ledger_unreadable")?;
            if !was {
                tx.execute("DELETE FROM soul_evolution_pauses",[]).map_err(|_|"ledger_write_failed")?;
                tx.execute("DELETE FROM soul_evidence",[]).map_err(|_|"ledger_write_failed")?;
                tx.execute("INSERT INTO soul_domain_baselines VALUES('evolution',?1) ON CONFLICT(domain) DO UPDATE SET cleared_through=max(cleared_through,excluded.cleared_through)",[now]).map_err(|_|"ledger_write_failed")?;
            }
            tx.execute("UPDATE soul_control SET evolution_enabled=1 WHERE singleton=1",[]).map_err(|_|"ledger_write_failed")?;
        }
        if input.mood_enabled == Some(true) {
            let was_enabled: bool = tx.query_row("SELECT mood_enabled FROM soul_control WHERE singleton=1",[],|row|row.get(0)).map_err(|_| "ledger_unreadable")?;
            if !was_enabled {
                tx.execute("DELETE FROM soul_mood_snapshot",[]).map_err(|_| "ledger_write_failed")?;
                tx.execute("DELETE FROM soul_events WHERE kind LIKE 'mood:%'",[]).map_err(|_| "ledger_write_failed")?;
                tx.execute("INSERT INTO soul_domain_baselines(domain,cleared_through) VALUES('mood',?1) ON CONFLICT(domain) DO UPDATE SET cleared_through=max(cleared_through,excluded.cleared_through)",[now]).map_err(|_| "ledger_write_failed")?;
            }
            tx.execute("UPDATE soul_control SET mood_enabled=1 WHERE singleton=1",[]).map_err(|_| "ledger_write_failed")?;
        }
        if input.mood_enabled == Some(false) {
            tx.execute("UPDATE soul_control SET mood_enabled=0 WHERE singleton=1", []).map_err(|_| "ledger_write_failed")?;
            tx.execute("DELETE FROM soul_mood_snapshot", []).map_err(|_| "ledger_write_failed")?;
            tx.execute("DELETE FROM soul_events WHERE kind LIKE 'mood:%'", []).map_err(|_| "ledger_write_failed")?;
            tx.execute("INSERT INTO soul_domain_baselines(domain,cleared_through) VALUES('mood',?1) ON CONFLICT(domain) DO UPDATE SET cleared_through=max(cleared_through,excluded.cleared_through)",[now]).map_err(|_| "ledger_write_failed")?;
        }
        if input.evolution_enabled == Some(false) {
            tx.execute("UPDATE soul_control SET evolution_enabled=0 WHERE singleton=1", []).map_err(|_| "ledger_write_failed")?;
        }
        let enabled_since = if (!enabled_old && enabled) || (paused_old && !paused) {
            Some(now)
        } else {
            enabled_since_old
        };
        let enabled_new: i64 = i64::from(enabled);
        let paused_new: i64 = i64::from(paused);
        tx.execute(
            "UPDATE soul_control SET revision=?1, enabled=?2, paused=?3, enabled_since=?4, category_settings=?5 WHERE singleton=1 AND revision=?6",
            rusqlite::params![
                revision + 1,
                enabled_new,
                paused_new,
                enabled_since,
                serde_json::to_string(&stored.iter().map(|(name, value)| json!({
                    "category": name,
                    "enabled": value.as_bool().unwrap_or(false),
                })).collect::<Vec<_>>())
                .map_err(|_| "invalid_settings".to_string())?,
                revision,
            ],
        )
        .map_err(|_| "ledger_write_failed".to_string())?;
        // Switches and revocation are one commit: a failed ledger write cannot
        // leave settings changed while visible/queued messages remain active.
        if !enabled || paused {
            tx.execute("UPDATE soul_proactive_ledger SET state='revoked',receipt_at=?1 WHERE state IN ('pending','dispatching','shown')",[now]).map_err(|_| "ledger_write_failed")?;
        } else if let Some(toggles) = &input.categories {
            for toggle in toggles.iter().filter(|toggle| !toggle.enabled) {
                let name = serde_json::to_value(toggle.category).unwrap();
                tx.execute("UPDATE soul_proactive_ledger SET state='revoked',receipt_at=?1 WHERE category=?2 AND state IN ('pending','dispatching','shown')",rusqlite::params![now,name.as_str().unwrap()]).map_err(|_| "ledger_write_failed")?;
            }
        }
        Ok(())
    })
}

pub fn clear(conn: &mut Connection, scopes: &[SoulDataScope], now: i64) -> Result<(), String> {
    if scopes.is_empty() {
        return Err("no_scope".into());
    }
    store::transaction(conn, |tx| {
        for scope in scopes {
            match scope {
                SoulDataScope::Profile => {
                    tx.execute("DELETE FROM soul_evidence",[]).map_err(|_|"ledger_write_failed")?;
                    tx.execute("DELETE FROM soul_candidates WHERE kind='evolution'",[]).map_err(|_|"ledger_write_failed")?;
                    tx.execute("INSERT INTO soul_domain_baselines VALUES('evolution',?1) ON CONFLICT(domain) DO UPDATE SET cleared_through=max(cleared_through,excluded.cleared_through)",[now]).map_err(|_|"ledger_write_failed")?;
                    tx.execute("DELETE FROM soul_profiles", [])
                        .map_err(|_| "ledger_write_failed".to_string())?;
                    tx.execute("DELETE FROM soul_role_versions", [])
                        .map_err(|_| "ledger_write_failed".to_string())?;
                }
                SoulDataScope::OpenLoops => {
                    tx.execute("DELETE FROM soul_topic_responses",[]).map_err(|_|"ledger_write_failed")?;
                    tx.execute("UPDATE soul_proactive_ledger SET state='revoked',receipt_at=?1 WHERE category='pattern' AND state IN ('pending','dispatching','shown')",[now]).map_err(|_|"ledger_write_failed")?;
                    tx.execute("INSERT INTO soul_domain_baselines(domain,cleared_through) VALUES('open_loops',?1) ON CONFLICT(domain) DO UPDATE SET cleared_through=excluded.cleared_through",[now]).map_err(|_| "ledger_write_failed")?;
                    tx.execute("INSERT OR IGNORE INTO soul_candidate_tombstones SELECT dedupe_key,source_ref,?1 FROM soul_candidates WHERE kind='open_loop'",[now]).map_err(|_| "ledger_write_failed")?;
                    tx.execute("UPDATE soul_proactive_ledger SET state='revoked',receipt_at=?1 WHERE category='open_loop' AND state IN ('pending','dispatching','shown')",[now]).map_err(|_| "ledger_write_failed")?;
                    tx.execute("DELETE FROM soul_open_loops", [])
                        .map_err(|_| "ledger_write_failed".to_string())?;
                    tx.execute("DELETE FROM soul_candidates WHERE kind='open_loop'", [])
                        .map_err(|_| "ledger_write_failed".to_string())?;
                }
                SoulDataScope::Proactive => {
                    tx.execute("DELETE FROM soul_output_observations",[]).map_err(|_|"ledger_write_failed")?;
                    tx.execute("INSERT INTO soul_domain_baselines(domain,cleared_through) VALUES('proactive',?1) ON CONFLICT(domain) DO UPDATE SET cleared_through=excluded.cleared_through",[now]).map_err(|_| "ledger_write_failed")?;
                    tx.execute("INSERT OR IGNORE INTO soul_delivery_tombstones SELECT dedupe_key,source_ref,?1 FROM soul_proactive_ledger",[now]).map_err(|_| "ledger_write_failed")?;
                    tx.execute("DELETE FROM soul_proactive_ledger", [])
                        .map_err(|_| "ledger_write_failed".to_string())?;
                    // Keep non-content quota/cooldown guards: clearing must never refund delivery.
                    tx.execute("DELETE FROM soul_backoff", [])
                        .map_err(|_| "ledger_write_failed".to_string())?;
                }
                SoulDataScope::Mood => {
                tx.execute("INSERT INTO soul_domain_baselines(domain,cleared_through) VALUES('mood',?1) ON CONFLICT(domain) DO UPDATE SET cleared_through=max(cleared_through,excluded.cleared_through)",[now]).map_err(|_| "ledger_write_failed")?;
                    tx.execute("DELETE FROM soul_mood_snapshot", [])
                        .map_err(|_| "ledger_write_failed".to_string())?;
                    tx.execute("DELETE FROM soul_events WHERE kind='mood' OR kind LIKE 'mood:%'", [])
                        .map_err(|_| "ledger_write_failed".to_string())?;
                }
                SoulDataScope::History => {
                    tx.execute("DELETE FROM soul_continuity_control",[]).map_err(|_|"ledger_write_failed")?;
                    tx.execute("UPDATE soul_proactive_ledger SET state='revoked',receipt_at=?1 WHERE category='milestone' AND state IN ('pending','dispatching','shown')",[now]).map_err(|_|"ledger_write_failed")?;
                    tx.execute("DELETE FROM soul_history_baseline", [])
                        .map_err(|_| "ledger_write_failed".to_string())?;
                    tx.execute("DELETE FROM soul_milestones", [])
                        .map_err(|_| "ledger_write_failed".to_string())?;
                    tx.execute("DELETE FROM soul_events WHERE kind='milestone'", [])
                        .map_err(|_| "ledger_write_failed".to_string())?;
                }
                SoulDataScope::All => {
                    tx.execute_batch("DELETE FROM soul_topic_responses; DELETE FROM soul_continuity_control; DELETE FROM soul_evidence; DELETE FROM soul_evolution_pauses; DELETE FROM soul_output_observations; DELETE FROM soul_observation_sources;").map_err(|_|"ledger_write_failed")?;
                    for domain in ["open_loops", "proactive", "mood", "history"] {
                        tx.execute("INSERT INTO soul_domain_baselines(domain,cleared_through) VALUES(?1,?2) ON CONFLICT(domain) DO UPDATE SET cleared_through=excluded.cleared_through",rusqlite::params![domain,now]).map_err(|_| "ledger_write_failed")?;
                    }
                    tx.execute("INSERT OR IGNORE INTO soul_delivery_tombstones SELECT dedupe_key,source_ref,?1 FROM soul_proactive_ledger",[now]).map_err(|_| "ledger_write_failed")?;
                    tx.execute("INSERT OR IGNORE INTO soul_candidate_tombstones SELECT dedupe_key,source_ref,?1 FROM soul_candidates",[now]).map_err(|_| "ledger_write_failed")?;
                    tx.execute(
                        "UPDATE soul_task_followups SET state='resolved',updated_at=?1",
                        [now],
                    )
                    .map_err(|_| "ledger_write_failed")?;
                    tx.execute_batch(
                        "DELETE FROM soul_profiles; DELETE FROM soul_role_versions;
                         DELETE FROM soul_open_loops; DELETE FROM soul_candidates;
                         DELETE FROM soul_proactive_ledger;
                         DELETE FROM soul_backoff; DELETE FROM soul_mood_snapshot;
                         DELETE FROM soul_events; DELETE FROM soul_history_baseline;
                         DELETE FROM soul_milestones;",
                    )
                    .map_err(|_| "ledger_write_failed".to_string())?;
                    // 清空即建立新基准：重启/重新开启都不扫描旧记录重建。
                    tx.execute(
                        "UPDATE soul_control SET enabled=0,paused=0,mood_enabled=0,evolution_enabled=0,revision=revision+1,enabled_since=?1, cleared_through=?1",
                        rusqlite::params![now],
                    )
                    .map_err(|_| "ledger_write_failed".to_string())?;
                }
            }
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn migrated() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        store::migrate(&mut conn).unwrap();
        conn
    }

    fn seed_active_message(conn: &Connection, id: &str, state: &str) {
        conn.execute(
            "INSERT INTO soul_proactive_ledger(id,category,source_ref,dedupe_key,template_id,valid_from,expires_at,state,created_at)
             VALUES(?1,'greeting','{}',?3,'t',100,1000,?2,100)",
            rusqlite::params![id, state, format!("key-{id}")],
        )
        .unwrap();
    }

    fn conn_state(conn: &Connection, id: &str) -> String {
        conn.query_row(
            "SELECT state FROM soul_proactive_ledger WHERE id=?1",
            rusqlite::params![id],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn first_open_creates_fail_closed_defaults_once() {
        let mut conn = migrated();
        let first = get(&mut conn, 100).unwrap();
        assert!(!first.enabled && first.revision == 1);
        let task = first
            .categories
            .iter()
            .find(|category| category.category == ProactiveCategory::TaskUnresolved)
            .unwrap();
        assert!(task.available && task.enabled && task.enabled_since.is_none());
        let p1 = first
            .categories
            .iter()
            .find(|category| category.category == ProactiveCategory::OpenLoop)
            .unwrap();
        assert!(p1.available);
        let again = get(&mut conn, 200).unwrap();
        assert_eq!(again.revision, 1);
        assert_eq!(first.enabled_since, again.enabled_since);
    }

    #[test]
    fn turning_off_or_pausing_requeues_revocation_and_refresh_baseline() {
        let mut conn = migrated();
        seed_active_message(&conn, "m1", "pending");
        get(&mut conn, 100).unwrap();
        let mut toggles = Vec::new();
        toggles.push(CategorySetting {
            category: ProactiveCategory::Greeting,
            enabled: true,
            available: true,
            enabled_since: None,
            daily_limit: 2,
        });
        update(
            &mut conn,
            &UpdateSoulSettingsInput {
                expected_revision: 1,
                enabled: Some(true),
                paused: None,
                categories: Some(toggles),
                mood_enabled: None,
                evolution_enabled: None,
            },
            100,
        )
        .unwrap();
        assert!(get(&mut conn, 100).unwrap().enabled);
        // Pausing revokes queued and visible messages right away...
        update(
            &mut conn,
            &UpdateSoulSettingsInput {
                expected_revision: 2,
                enabled: None,
                paused: Some(true),
                categories: None,
                mood_enabled: None,
                evolution_enabled: None,
            },
            150,
        )
        .unwrap();
        assert!(get(&mut conn, 150).unwrap().paused);
        assert_eq!(conn_state(&conn, "m1"), "revoked");
        // Resuming refreshes the enable baseline without rescheduling old work.
        update(
            &mut conn,
            &UpdateSoulSettingsInput {
                expected_revision: 3,
                enabled: None,
                paused: Some(false),
                categories: None,
                mood_enabled: None,
                evolution_enabled: None,
            },
            200,
        )
        .unwrap();
        let settings = get(&mut conn, 200).unwrap();
        assert!(!settings.paused);
        assert_eq!(settings.enabled_since, Some(200));
    }

    #[test]
    fn stale_revision_rejected_and_client_limits_never_override_policy() {
        let mut conn=migrated();get(&mut conn,100).unwrap();
        let mut input=UpdateSoulSettingsInput{expected_revision:9,enabled:Some(true),paused:None,categories:None,mood_enabled:None,evolution_enabled:None};
        assert_eq!(update(&mut conn,&input,100).unwrap_err(),"revision_conflict");
        input.expected_revision=1;input.categories=Some(vec![CategorySetting{category:ProactiveCategory::OpenLoop,enabled:true,available:false,enabled_since:Some(0),daily_limit:999}]);
        update(&mut conn,&input,100).unwrap();
        let settings=get(&mut conn,100).unwrap();let topic=settings.categories.iter().find(|row|row.category==ProactiveCategory::OpenLoop).unwrap();
        assert!(topic.available);assert_eq!(topic.daily_limit,1);assert_eq!(topic.enabled_since,Some(100));
    }

    #[test]
    fn scoped_clear_keeps_other_domains_and_rebases_on_all() {
        let mut conn = migrated();
        get(&mut conn, 100).unwrap();
        conn.execute(
            "INSERT INTO soul_profiles(profile_id,revision,default_resource_version,user_overrides,confirmed_evolution,updated_at)
             VALUES('piko',1,'1','{}','{}',100)",
            [],
        )
        .unwrap();
        seed_active_message(&conn, "m1", "pending");
        clear(&mut conn, &[SoulDataScope::OpenLoops], 150).unwrap();
        let profiles: i64 = conn
            .query_row("SELECT count(*) FROM soul_profiles", [], |r| r.get(0))
            .unwrap();
        assert_eq!(profiles, 1);
        clear(&mut conn, &[SoulDataScope::Proactive], 160).unwrap();
        let ledger: i64 = conn
            .query_row("SELECT count(*) FROM soul_proactive_ledger", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(ledger, 0);
        seed_active_message(&conn, "m2", "pending");
        clear(&mut conn, &[SoulDataScope::All], 200).unwrap();
        for table in [
            "soul_profiles",
            "soul_open_loops",
            "soul_candidates",
            "soul_proactive_ledger",
            "soul_quota",
            "soul_backoff",
            "soul_mood_snapshot",
            "soul_events",
            "soul_history_baseline",
            "soul_milestones",
        ] {
            let rows: i64 = conn
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(rows, 0, "{table} must be empty");
        }
        let cleared_through: i64 = conn
            .query_row("SELECT cleared_through FROM soul_control", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cleared_through, 200);
    }
}

pub fn pause_intent(prompt: &str) -> Option<bool> {
    match prompt.trim().trim_end_matches(['。', '.', '!', '！']) {
        "不要说话"
        | "先别说话"
        | "暂停主动消息"
        | "stop talking"
        | "pause proactive messages"
        | "話しかけないで" => Some(true),
        "可以说话了"
        | "恢复主动消息"
        | "resume proactive messages"
        | "you can talk again"
        | "また話しかけて" => Some(false),
        _ => None,
    }
}

pub fn apply_pause_intent(app: &tauri::AppHandle, prompt: &str) {
    use tauri::Manager;
    let Some(paused) = pause_intent(prompt) else {
        return;
    };
    let db = app.state::<std::sync::Arc<crate::memory::MemoryDb>>();
    let Ok(mut conn) = db.0.lock() else { return };
    let now = chrono::Utc::now().timestamp();
    if let Ok(current) = get(&mut conn, now) {
        let input = UpdateSoulSettingsInput {
            expected_revision: current.revision,
            enabled: None,
            paused: Some(paused),
            categories: None,
            mood_enabled: None,
            evolution_enabled: None,
        };
        if update(&mut conn, &input, now).is_ok() {
            drop(conn);
            super::commands::reconcile_visible(app);
        }
    }
}

#[cfg(test)]
mod atomic_switch_tests {
    use super::*;
    #[test]
    fn revocation_failure_does_not_commit_the_switch_or_revision() {
        let mut conn=Connection::open_in_memory().unwrap();store::migrate(&mut conn).unwrap();get(&mut conn,100).unwrap();
        conn.execute("UPDATE soul_control SET enabled=1",[]).unwrap();
        conn.execute_batch("INSERT INTO soul_proactive_ledger(id,category,source_ref,dedupe_key,template_id,valid_from,expires_at,state,created_at) VALUES('m','greeting','{}','k','greeting',100,200,'shown',100); CREATE TRIGGER revoke_error BEFORE UPDATE OF state ON soul_proactive_ledger BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
        let result=update(&mut conn,&UpdateSoulSettingsInput{expected_revision:1,enabled:Some(false),paused:None,categories:None,mood_enabled:None,evolution_enabled:None},150);
        assert!(result.is_err());
        let state=get(&mut conn,150).unwrap();assert!(state.enabled);assert_eq!(state.revision,1);
    }
    #[test]
    fn pause_only_accepts_explicit_direct_commands() {
        assert_eq!(pause_intent("不要说话。"),Some(true));
        assert_eq!(pause_intent("恢复主动消息"),Some(false));
        assert_eq!(pause_intent("例如：不要说话"),None);
        assert_eq!(pause_intent("他说不要说话"),None);
    }
}

#[cfg(test)]
mod mood_switch_tests {
    use super::*;
    #[test]
    fn disabling_mood_clears_scores_and_prevents_same_second_replay() {
        let mut conn=Connection::open_in_memory().unwrap();store::migrate(&mut conn).unwrap();get(&mut conn,100).unwrap();
        conn.execute("UPDATE soul_control SET mood_enabled=1",[]).unwrap();
        let source=SourceRef{kind:"agent_task".into(),id:"a".into(),revision:1};
        super::super::mood::event(&mut conn,"task_success",&source,100,100).unwrap();
        assert!(get(&mut conn,100).unwrap().mood_enabled);
        update(&mut conn,&UpdateSoulSettingsInput{expected_revision:1,enabled:None,paused:None,categories:None,mood_enabled:Some(false),evolution_enabled:None},200).unwrap();
        assert!(!get(&mut conn,200).unwrap().mood_enabled);
        assert_eq!(conn.query_row("SELECT count(*) FROM soul_mood_snapshot",[],|row|row.get::<_,i64>(0)).unwrap(),0);
        conn.execute("UPDATE soul_control SET mood_enabled=1",[]).unwrap();
        super::super::mood::event(&mut conn,"task_success",&source,200,300).unwrap();
        assert_eq!(conn.query_row("SELECT count(*) FROM soul_events WHERE kind LIKE 'mood:%'",[],|row|row.get::<_,i64>(0)).unwrap(),0);
    }
}

#[cfg(test)]
mod mood_enable_tests {
    use super::*;
    fn patch(revision:i64, enabled:bool) -> UpdateSoulSettingsInput {
        UpdateSoulSettingsInput{expected_revision:revision,enabled:None,paused:None,categories:None,mood_enabled:Some(enabled),evolution_enabled:None}
    }
    #[test]
    fn enable_starts_fresh_repeated_enable_preserves_state_and_scoped_clear_rebases() {
        let mut conn=Connection::open_in_memory().unwrap(); store::migrate(&mut conn).unwrap(); get(&mut conn,100).unwrap();
        update(&mut conn,&patch(1,true),200).unwrap();
        let source=SourceRef{kind:"agent_task".into(),id:"a".into(),revision:1};
        super::super::mood::event(&mut conn,"task_success",&source,199,201).unwrap();
        assert_eq!(conn.query_row("SELECT count(*) FROM soul_events",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        super::super::mood::event(&mut conn,"task_success",&source,201,201).unwrap();
        update(&mut conn,&patch(2,true),202).unwrap();
        assert_eq!(conn.query_row("SELECT count(*) FROM soul_events",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        clear(&mut conn,&[SoulDataScope::Mood],300).unwrap();
        super::super::mood::event(&mut conn,"task_success",&source,201,301).unwrap();
        assert_eq!(conn.query_row("SELECT count(*) FROM soul_events",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        clear(&mut conn,&[SoulDataScope::All],400).unwrap();
        assert!(!get(&mut conn,401).unwrap().mood_enabled);
    }
}

/// Per-category content cleanup retains the global and category quota bucket.
pub fn clear_category(conn:&mut Connection,category:ProactiveCategory,revision:i64,now:i64)->Result<(),String>{
 let name=serde_json::to_value(category).map_err(|_|"invalid_category")?.as_str().ok_or("invalid_category")?.to_string();
 store::transaction(conn,|tx|{
  if tx.execute("UPDATE soul_control SET revision=revision+1 WHERE singleton=1 AND revision=?1",[revision]).map_err(|_|"ledger_write_failed")?!=1{return Err("revision_conflict".into());}
  tx.execute("INSERT INTO soul_category_baselines VALUES(?1,?2) ON CONFLICT(category) DO UPDATE SET enabled_since=max(enabled_since,excluded.enabled_since)",rusqlite::params![name,now]).map_err(|_|"ledger_write_failed")?;
  tx.execute("INSERT OR IGNORE INTO soul_delivery_tombstones SELECT dedupe_key,source_ref,?2 FROM soul_proactive_ledger WHERE category=?1",rusqlite::params![name,now]).map_err(|_|"ledger_write_failed")?;
  tx.execute("DELETE FROM soul_proactive_ledger WHERE category=?1",[&name]).map_err(|_|"ledger_write_failed")?;
  tx.execute("DELETE FROM soul_backoff WHERE category=?1",[&name]).map_err(|_|"ledger_write_failed")?;
  if category==ProactiveCategory::OutputFeedback{tx.execute("DELETE FROM soul_output_observations",[]).map_err(|_|"ledger_write_failed")?;}
  Ok(())
 })
}

#[cfg(test)]
mod quota_cleanup_tests{
 use super::*;
 #[test]
 fn category_and_all_cleanup_do_not_refund_quota_or_delete_business_topics(){
  let mut conn=Connection::open_in_memory().unwrap();store::migrate(&mut conn).unwrap();get(&mut conn,100).unwrap();
  conn.execute("INSERT INTO soul_quota VALUES(1,'2026-10-17','UTC',100,86500,2,'{\"greeting\":1,\"task_unresolved\":1}',100)",[]).unwrap();
  conn.execute("INSERT INTO soul_proactive_ledger(id,category,source_ref,dedupe_key,template_id,valid_from,expires_at,state,created_at) VALUES('g','greeting','{\"kind\":\"app_event\",\"id\":\"event\",\"revision\":1}','g','greeting',100,1000,'pending',100)",[]).unwrap();
  clear_category(&mut conn,ProactiveCategory::Greeting,1,101).unwrap();
  assert_eq!(conn.query_row("SELECT count(*) FROM soul_proactive_ledger",[],|r|r.get::<_,i64>(0)).unwrap(),0);
  assert_eq!(conn.query_row("SELECT total_used FROM soul_quota",[],|r|r.get::<_,i64>(0)).unwrap(),2);
  clear(&mut conn,&[SoulDataScope::All],102).unwrap();
  assert_eq!(conn.query_row("SELECT total_used FROM soul_quota",[],|r|r.get::<_,i64>(0)).unwrap(),2);
  assert!(!get(&mut conn,103).unwrap().enabled);
 }
}
