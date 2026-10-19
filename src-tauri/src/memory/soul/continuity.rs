//! Minimal shared history and confirmed, bounded profile evolution. Never a model tool.
use super::{model::*, proactive, profile, store};
use chrono::TimeZone;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
const WEEK: i64 = 604800;
#[derive(Debug, Serialize, Deserialize)]
pub struct Continuity {
    pub revision: i64,
    pub history_enabled: bool,
    pub days: i64,
    pub nickname: Option<String>,
    pub milestones: Vec<String>,
    pub nickname_options: Vec<String>,
    pub proposals: Vec<Value>,
    pub versions: Vec<Value>,
}
fn initialize(conn: &Connection, now: i64) -> Result<(), String> {
    conn.execute("INSERT INTO soul_continuity_control VALUES(1,1,0,?1,?2,NULL) ON CONFLICT(singleton) DO NOTHING",params![now,iana_time_zone::get_timezone().unwrap_or_else(|_|"UTC".into())]).map_err(|_|"ledger_write_failed")?;
    Ok(())
}
pub fn get(conn: &mut Connection, now: i64) -> Result<Continuity, String> {
    initialize(conn, now)?;
    let(revision,enabled,baseline,zone,nickname):(i64,bool,i64,String,Option<String>)=conn.query_row("SELECT revision,history_enabled,enabled_at,timezone,nickname FROM soul_continuity_control WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).map_err(|_|"ledger_unreadable")?;
    let mut stmt = conn
        .prepare("SELECT milestone_key FROM soul_milestones ORDER BY achieved_at,milestone_key")
        .map_err(|_| "ledger_unreadable")?;
    let milestones: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .map_err(|_| "ledger_unreadable")?
        .collect::<Result<_, _>>()
        .map_err(|_| "ledger_unreadable")?;
    let zone: chrono_tz::Tz = zone.parse().map_err(|_| "invalid_timezone")?;
    let days = if enabled {
        zone.timestamp_opt(now, 0)
            .single()
            .zip(zone.timestamp_opt(baseline, 0).single())
            .map(|(now, start)| (now.date_naive() - start.date_naive()).num_days().max(0) + 1)
            .unwrap_or(1)
    } else {
        0
    };
    let mut options = vec![];
    if enabled && milestones.iter().any(|m| m == "first_task") {
        options.push("partner".into());
    }
    if enabled && milestones.iter().any(|m| m == "first_reply") {
        options.push("friend".into());
    }
    let mut stmt=conn.prepare("SELECT id,payload FROM soul_candidates WHERE kind='evolution' AND status='pending_review' ORDER BY created_at DESC").map_err(|_|"ledger_unreadable")?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|_| "ledger_unreadable")?;
    let mut proposals = vec![];
    for row in rows {
        let (id, raw) = row.map_err(|_| "ledger_unreadable")?;
        let mut value: Value = serde_json::from_str(&raw).map_err(|_| "invalid_candidate")?;
        value["id"] = json!(id);
        proposals.push(value);
    }
    let mut stmt=conn.prepare("SELECT id,revision,snapshot,created_at FROM soul_role_versions WHERE profile_id='piko' ORDER BY revision DESC LIMIT 50").map_err(|_|"ledger_unreadable")?;
    let versions=stmt.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"revision":r.get::<_,i64>(1)?,"snapshot":r.get::<_,String>(2)?,"created_at":r.get::<_,i64>(3)?}))).map_err(|_|"ledger_unreadable")?.collect::<Result<Vec<_>,_>>().map_err(|_|"ledger_unreadable")?;
    Ok(Continuity {
        revision,
        history_enabled: enabled,
        days,
        nickname,
        milestones,
        nickname_options: options,
        proposals,
        versions,
    })
}
pub fn update(
    conn: &mut Connection,
    revision: i64,
    enabled: bool,
    nickname: Option<String>,
    now: i64,
) -> Result<(), String> {
    let current = get(conn, now)?;
    if current.revision != revision {
        return Err("revision_conflict".into());
    }
    if nickname
        .as_ref()
        .is_some_and(|name| !enabled || !current.nickname_options.contains(name))
    {
        return Err("nickname_locked".into());
    }
    store::transaction(conn, |tx| {
        if enabled && !current.history_enabled {
            tx.execute("DELETE FROM soul_history_baseline", [])
                .map_err(|_| "ledger_write_failed")?;
            tx.execute(
                "INSERT INTO soul_history_baseline VALUES(1,?1,?2,?3)",
                params![
                    now,
                    chrono::Local::now().date_naive().to_string(),
                    iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".into())
                ],
            )
            .map_err(|_| "ledger_write_failed")?;
        }
        tx.execute("UPDATE soul_continuity_control SET revision=revision+1,history_enabled=?2,nickname=?3,enabled_at=CASE WHEN history_enabled=0 AND ?2=1 THEN ?4 ELSE enabled_at END,timezone=CASE WHEN history_enabled=0 AND ?2=1 THEN ?5 ELSE timezone END WHERE singleton=1 AND revision=?1",params![revision,enabled,nickname,now,iana_time_zone::get_timezone().unwrap_or_else(|_|"UTC".into())]).map_err(|_|"ledger_write_failed")?;
        if !enabled {
            tx.execute("UPDATE soul_proactive_ledger SET state='revoked',receipt_at=?1 WHERE category='milestone' AND state IN ('pending','dispatching','shown')",[now]).map_err(|_|"ledger_write_failed")?;
        }
        Ok(())
    })
}
pub(crate) fn record_event(
    conn: &mut Connection,
    kind: &str,
    source: &SourceRef,
    occurred_at: i64,
    now: i64,
) -> Result<(), String> {
    let milestone = match kind {
        "task_completed" => "first_task",
        "proactive_responded" => "first_reply",
        "thanks" => "first_thanks",
        "favorite_saved" => "first_favorite",
        "shared_week" => "shared_week",
        _ => return Ok(()),
    };
    let Some((true, baseline)) = conn
        .query_row(
            "SELECT history_enabled,enabled_at FROM soul_continuity_control WHERE singleton=1",
            [],
            |r| Ok((r.get::<_, bool>(0)?, r.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|_| "ledger_unreadable")?
    else {
        return Ok(());
    };
    if occurred_at <= baseline || occurred_at > now {
        return Ok(());
    }
    store::transaction(conn, |tx| {
        let changed=tx.execute("INSERT INTO soul_milestones VALUES(?1,?2,?3) ON CONFLICT(milestone_key) DO NOTHING",params![milestone,occurred_at,serde_json::to_string(source).map_err(|_|"invalid_source")?]).map_err(|_|"ledger_write_failed")?;
        if changed == 1 && proactive::event_allowed(tx, ProactiveCategory::Milestone, occurred_at)?
        {
            proactive::queue(
                tx,
                ProactiveMessage {
                    id: format!("milestone-{milestone}-{baseline}"),
                    category: ProactiveCategory::Milestone,
                    source: source.clone(),
                    dedupe_key: format!("milestone:{milestone}:{baseline}"),
                    template_id: format!("milestone_{milestone}"),
                    valid_from: now,
                    expires_at: now + 86400,
                    state: DeliveryState::Pending,
                },
                now,
            )?;
        }
        Ok(())
    })
}
/// No free-form evidence extraction: only exact, explicit style choices qualify.
fn preference(text: &str) -> Option<(&'static str, Value)> {
    match text.trim().trim_end_matches(['。', '.', '!', '！']) {
        "请说得简洁一些" | "请简洁一点" | "be more concise" | "簡潔に話して" => {
            Some((
                "tone",
                json!("简洁、直接，先给结论；保留必要的事实与不确定性。"),
            ))
        }
        "请热情一点" | "be a little warmer" | "もう少し明るく話して" => Some((
            "tone",
            json!("适度热情，清楚表达；不夸大结果，不改变事实与权限。"),
        )),
        "口头禅用一步一步来" | "use the phrase step by step" | "口癖は一歩ずつにして" => {
            Some(("catchphrases", json!(["一步一步来。"])))
        }
        _ => None,
    }
}
pub fn observe_preference(
    conn: &mut Connection,
    conversation: &str,
    source: &SourceRef,
    text: &str,
    now: i64,
) -> Result<(), String> {
    let Some((field, value)) = preference(text) else {
        return Ok(());
    };
    let enabled = conn
        .query_row(
            "SELECT evolution_enabled FROM soul_control WHERE singleton=1",
            [],
            |r| r.get::<_, bool>(0),
        )
        .optional()
        .map_err(|_| "ledger_unreadable")?
        .unwrap_or(false);
    if !enabled {
        return Ok(());
    }
    store::transaction(conn, |tx| {
        let deleted: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM soul_source_tombstones WHERE source_id=?1)",
                [&source.id],
                |r| r.get(0),
            )
            .map_err(|_| "ledger_unreadable")?;
        if deleted {
            return Ok(());
        }
        let paused: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM soul_evolution_pauses WHERE field=?1)",
                [field],
                |r| r.get(0),
            )
            .map_err(|_| "ledger_unreadable")?;
        if paused {
            return Ok(());
        }
        let baseline: i64 = tx
            .query_row(
                "SELECT cleared_through FROM soul_domain_baselines WHERE domain='evolution'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| "ledger_unreadable")?
            .unwrap_or(0);
        if now <= baseline {
            return Ok(());
        }
        let key = format!("evolution:{field}:{value}");
        tx.execute(
            "INSERT INTO soul_evidence VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT DO NOTHING",
            params![
                format!("{}:{field}:{}", source.id, source.revision),
                conversation,
                serde_json::to_string(source).map_err(|_| "invalid_source")?,
                field,
                value.to_string(),
                now
            ],
        )
        .map_err(|_| "ledger_write_failed")?;
        let count:i64=tx.query_row("SELECT count(DISTINCT conversation_id) FROM soul_evidence WHERE field=?1 AND value=?2 AND occurred_at>?3",params![field,value.to_string(),baseline],|r|r.get(0)).map_err(|_|"ledger_unreadable")?;
        let last:Option<i64>=tx.query_row("SELECT max(created_at) FROM soul_candidates WHERE kind='evolution' AND json_extract(payload,'$.field')=?1",[field],|r|r.get(0)).map_err(|_|"ledger_unreadable")?;
        if count < 3 || last.is_some_and(|last| now < last + WEEK) {
            return Ok(());
        }
        let retired: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM soul_candidate_tombstones WHERE dedupe_key=?1)",
                [&key],
                |r| r.get(0),
            )
            .map_err(|_| "ledger_unreadable")?;
        if retired {
            return Ok(());
        }
        let previous: Option<String> = tx
            .query_row(
                "SELECT confirmed_evolution FROM soul_profiles WHERE profile_id='piko'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| "ledger_unreadable")?;
        let previous: Value = previous
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or(json!({}));
        tx.execute("INSERT INTO soul_candidates VALUES(?1,'evolution',?2,?1,?3,'pending_review',?4,NULL) ON CONFLICT DO NOTHING",params![key,serde_json::to_string(source).unwrap(),json!({"field":field,"before":previous.get(field),"after":value,"evidence_count":count}).to_string(),now]).map_err(|_|"ledger_write_failed")?;
        Ok(())
    })
}
fn save_version(
    tx: &rusqlite::Transaction<'_>,
    revision: i64,
    layer: &Value,
    source: &Value,
    now: i64,
) -> Result<(), String> {
    let old: String = tx
        .query_row(
            "SELECT confirmed_evolution FROM soul_profiles WHERE profile_id='piko' AND revision=?1",
            [revision],
            |r| r.get(0),
        )
        .map_err(|_| "revision_conflict")?;
    tx.execute(
        "INSERT INTO soul_role_versions VALUES(?1,'piko',?2,?3,?4,?5) ON CONFLICT DO NOTHING",
        params![
            format!("role-{revision}"),
            revision,
            json!({"kind":"profile","id":"piko","revision":revision}).to_string(),
            old,
            now
        ],
    )
    .map_err(|_| "ledger_write_failed")?;
    let changes=tx.execute("UPDATE soul_profiles SET revision=revision+1,confirmed_evolution=?2,updated_at=?3 WHERE profile_id='piko' AND revision=?1",params![revision,layer.to_string(),now]).map_err(|_|"ledger_write_failed")?;
    if changes != 1 {
        return Err("revision_conflict".into());
    }
    tx.execute(
        "INSERT INTO soul_role_versions VALUES(?1,'piko',?2,?3,?4,?5)",
        params![
            format!("role-{}", revision + 1),
            revision + 1,
            source.to_string(),
            layer.to_string(),
            now
        ],
    )
    .map_err(|_| "ledger_write_failed")?;
    tx.execute("DELETE FROM soul_role_versions WHERE profile_id='piko' AND id NOT IN(SELECT id FROM soul_role_versions WHERE profile_id='piko' ORDER BY revision DESC LIMIT 50)",[]).map_err(|_|"ledger_write_failed")?;
    Ok(())
}
pub fn review_evolution(
    conn: &mut Connection,
    id: &str,
    approve: bool,
    revision: i64,
    locale: &str,
    now: i64,
) -> Result<(), String> {
    profile::load_or_create(conn, locale, now)?;
    store::transaction(conn, |tx| {
        let(raw,source):(String,String)=tx.query_row("SELECT payload,source_ref FROM soul_candidates WHERE id=?1 AND kind='evolution' AND status='pending_review'",[id],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_|"candidate_missing")?;
        if approve {
            let enabled: bool = tx
                .query_row(
                    "SELECT evolution_enabled FROM soul_control WHERE singleton=1",
                    [],
                    |r| r.get(0),
                )
                .map_err(|_| "ledger_unreadable")?;
            if !enabled {
                return Err("evolution_disabled".into());
            }
            let proposal: Value = serde_json::from_str(&raw).map_err(|_| "invalid_candidate")?;
            let field = proposal["field"].as_str().ok_or("invalid_candidate")?;
            if !matches!(field, "tone" | "catchphrases") {
                return Err("invalid_candidate".into());
            }
            let mut layer: Value = serde_json::from_str(
                &tx.query_row(
                    "SELECT confirmed_evolution FROM soul_profiles WHERE profile_id='piko'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .map_err(|_| "profile_missing")?,
            )
            .map_err(|_| "invalid_profile")?;
            if layer.get(field).unwrap_or(&Value::Null) != &proposal["before"] {
                return Err("revision_conflict".into());
            }
            layer[field] = proposal["after"].clone();
            let _: RoleOverrides =
                serde_json::from_value(layer.clone()).map_err(|_| "invalid_profile")?;
            save_version(
                tx,
                revision,
                &layer,
                &serde_json::from_str::<Value>(&source).map_err(|_| "invalid_source")?,
                now,
            )?;
        }
        tx.execute(
            "UPDATE soul_candidates SET status=?2,reviewed_at=?3 WHERE id=?1",
            params![id, if approve { "approved" } else { "rejected" }, now],
        )
        .map_err(|_| "ledger_write_failed")?;
        Ok(())
    })
}
pub fn rollback(conn: &mut Connection, id: &str, revision: i64, now: i64) -> Result<(), String> {
    store::transaction(conn, |tx| {
        let raw: String = tx
            .query_row(
                "SELECT snapshot FROM soul_role_versions WHERE id=?1 AND profile_id='piko'",
                [id],
                |r| r.get(0),
            )
            .map_err(|_| "version_missing")?;
        let layer: Value = serde_json::from_str(&raw).map_err(|_| "invalid_profile")?;
        let _: RoleOverrides =
            serde_json::from_value(layer.clone()).map_err(|_| "invalid_profile")?;
        save_version(
            tx,
            revision,
            &layer,
            &json!({"kind":"rollback","id":id,"revision":revision}),
            now,
        )?;
        for field in ["tone", "catchphrases"] {
            tx.execute("INSERT INTO soul_evolution_pauses VALUES(?1,?2) ON CONFLICT(field) DO UPDATE SET paused_at=?2",params![field,now]).map_err(|_|"ledger_write_failed")?;
        }
        tx.execute("UPDATE soul_candidates SET status='rejected',reviewed_at=?1 WHERE kind='evolution' AND status='pending_review'",[now]).map_err(|_|"ledger_write_failed")?;
        Ok(())
    })
}
pub fn nickname(conn: &Connection, locale: &str) -> Option<String> {
    let key: Option<String> = conn
        .query_row(
            "SELECT nickname FROM soul_continuity_control WHERE singleton=1 AND history_enabled=1",
            [],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten()
        .flatten();
    match (key.as_deref(), locale) {
        (Some("partner"), "en-US") => Some("partner".into()),
        (Some("friend"), "en-US") => Some("friend".into()),
        (Some("partner"), "ja-JP") => Some("相棒".into()),
        (Some("friend"), "ja-JP") => Some("友達".into()),
        (Some("partner"), _) => Some("搭档".into()),
        (Some("friend"), _) => Some("朋友".into()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        store::migrate(&mut c).unwrap();
        super::super::settings::get(&mut c, 100).unwrap();
        profile::load_or_create(&mut c, "zh-CN", 100).unwrap();
        c
    }
    fn source(id: &str) -> SourceRef {
        SourceRef {
            kind: "chat_session".into(),
            id: id.into(),
            revision: 1,
        }
    }
    #[test]
    fn history_requires_new_committed_evidence_and_never_selects_name() {
        let mut c = db();
        let initial = get(&mut c, 100).unwrap();
        assert!(!initial.history_enabled);
        record_event(&mut c, "task_completed", &source("old"), 90, 100).unwrap();
        assert!(get(&mut c, 100).unwrap().milestones.is_empty());
        update(&mut c, initial.revision, true, None, 101).unwrap();
        record_event(&mut c, "task_completed", &source("old"), 100, 102).unwrap();
        assert!(get(&mut c, 102).unwrap().milestones.is_empty());
        record_event(&mut c, "task_completed", &source("new"), 102, 102).unwrap();
        record_event(&mut c, "task_completed", &source("new"), 102, 103).unwrap();
        let state = get(&mut c, 103).unwrap();
        assert_eq!(state.milestones, vec!["first_task"]);
        assert_eq!(state.nickname, None);
        assert_eq!(state.nickname_options, vec!["partner"]);
        assert_eq!(
            update(&mut c, state.revision, true, Some("friend".into()), 104).unwrap_err(),
            "nickname_locked"
        );
        update(&mut c, state.revision, true, Some("partner".into()), 104).unwrap();
        assert_eq!(nickname(&c, "en-US"), Some("partner".into()));
        super::super::settings::clear(&mut c, &[SoulDataScope::History], 105).unwrap();
        assert_eq!(nickname(&c, "en-US"), None);
        assert!(get(&mut c, 106).unwrap().milestones.is_empty());
    }
    #[test]
    fn three_distinct_conversations_approval_preserves_override_rollback_creates_version() {
        let mut c = db();
        c.execute("UPDATE soul_control SET evolution_enabled=1", [])
            .unwrap();
        for i in 0..3 {
            observe_preference(
                &mut c,
                "one",
                &source(&format!("one-{i}")),
                "请简洁一点",
                101 + i,
            )
            .unwrap();
        }
        assert!(get(&mut c, 104).unwrap().proposals.is_empty());
        for (i, name) in ["two", "three"].iter().enumerate() {
            observe_preference(&mut c, name, &source(name), "请简洁一点", 105 + i as i64).unwrap();
        }
        let proposal = get(&mut c, 108).unwrap().proposals.pop().unwrap();
        profile::update(
            &mut c,
            UpdateRoleInput {
                expected_revision: 1,
                locale: "zh-CN".into(),
                user_overrides: RoleOverrides {
                    tone: Some("my explicit tone".into()),
                    ..Default::default()
                },
            },
            109,
        )
        .unwrap();
        review_evolution(
            &mut c,
            proposal["id"].as_str().unwrap(),
            true,
            2,
            "zh-CN",
            110,
        )
        .unwrap();
        let card = profile::load_or_create(&mut c, "zh-CN", 111).unwrap();
        assert_eq!(card.effective.tone, "my explicit tone");
        assert_eq!(card.revision, 3);
        rollback(&mut c, "role-2", 3, 112).unwrap();
        assert_eq!(
            profile::load_or_create(&mut c, "zh-CN", 113)
                .unwrap()
                .revision,
            4
        );
        assert_eq!(
            c.query_row("SELECT count(*) FROM soul_evolution_pauses", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
        observe_preference(&mut c, "four", &source("four"), "请热情一点", 113 + WEEK).unwrap();
        assert!(get(&mut c, 114 + WEEK).unwrap().proposals.is_empty());
    }
    #[test]
    fn rejection_and_source_deletion_prevent_reproposal() {
        let mut c = db();
        c.execute("UPDATE soul_control SET evolution_enabled=1", [])
            .unwrap();
        for (name, at) in [("a", 101), ("b", 102), ("c", 103)] {
            observe_preference(&mut c, name, &source(name), "请简洁一点", at).unwrap();
        }
        let id = get(&mut c, 104).unwrap().proposals[0]["id"]
            .as_str()
            .unwrap()
            .to_string();
        review_evolution(&mut c, &id, false, 1, "zh-CN", 104).unwrap();
        observe_preference(&mut c, "d", &source("d"), "请简洁一点", 105 + WEEK).unwrap();
        assert!(get(&mut c, 106 + WEEK).unwrap().proposals.is_empty());
        super::super::lifecycle::delete_sources(&mut c, &["deleted".to_string()], 106 + WEEK)
            .unwrap();
        observe_preference(
            &mut c,
            "deleted",
            &source("deleted"),
            "请热情一点",
            107 + WEEK,
        )
        .unwrap();
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM soul_evidence WHERE conversation_id='deleted'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
    #[test]
    fn natural_days_and_rollback_do_not_create_extra_days() {
        let mut c = db();
        let state = get(&mut c, 100).unwrap();
        update(&mut c, state.revision, true, None, 100).unwrap();
        c.execute("UPDATE soul_continuity_control SET timezone='UTC'", [])
            .unwrap();
        assert_eq!(get(&mut c, 86400).unwrap().days, 2);
        assert_eq!(get(&mut c, 50).unwrap().days, 1);
    }
}

#[cfg(test)]
mod retention_tests {
    use super::*;
    #[test]
    fn versions_are_bounded_and_failed_rollback_is_atomic() {
        let mut c = Connection::open_in_memory().unwrap();
        store::migrate(&mut c).unwrap();
        profile::load_or_create(&mut c, "en-US", 100).unwrap();
        for revision in 1..=55 {
            store::transaction(&mut c, |tx| {
                save_version(
                    tx,
                    revision,
                    &json!({"tone":format!("tone {revision}")}),
                    &json!({"kind":"test","id":"source","revision":revision}),
                    100 + revision,
                )
            })
            .unwrap();
        }
        assert_eq!(
            c.query_row("SELECT count(*) FROM soul_role_versions", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            50
        );
        assert!(rollback(&mut c, "role-1", 56, 200).is_err());
        c.execute_batch("CREATE TRIGGER fail_version BEFORE INSERT ON soul_role_versions BEGIN SELECT RAISE(ABORT,'test'); END").unwrap();
        assert!(rollback(&mut c, "role-54", 56, 201).is_err());
        assert_eq!(
            profile::load_or_create(&mut c, "en-US", 202)
                .unwrap()
                .revision,
            56
        );
    }
}
