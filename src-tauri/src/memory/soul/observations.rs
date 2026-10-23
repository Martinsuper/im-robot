//! Offline templates use only confirmed plans or native preview/favorite evidence.
use super::{model::*, proactive, store};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
#[derive(Default)]
pub struct PreviewVisibility(pub Mutex<HashMap<String, (String, Instant, Instant)>>);
pub fn register_preview(
    conn: &mut Connection,
    id: &str,
    owner: &str,
    source: &str,
    now: i64,
) -> Result<(), String> {
    store::transaction(conn, |tx| {
        if !proactive::event_allowed(tx, ProactiveCategory::OutputFeedback, now)? {
            return Ok(());
        }
        tx.execute("INSERT INTO soul_output_observations(output_id,created_at,output_kind,source_ref,owner_window) VALUES(?1,?2,'html',?3,?4) ON CONFLICT DO NOTHING",params![id,now,serde_json::to_string(&SourceRef{kind:"chat_session".into(),id:source.into(),revision:1}).unwrap(),owner]).map_err(|_|crate::error_codes::LEDGER_WRITE_FAILED)?;
        Ok(())
    })
}
pub fn visible(
    conn: &mut Connection,
    registry: &PreviewVisibility,
    id: &str,
    owner: &str,
    is_visible: bool,
    now: i64,
    mono: Instant,
) -> Result<(), String> {
    let mut timers = registry
        .0
        .lock()
        .map_err(|_| crate::error_codes::VISIBILITY_UNAVAILABLE)?;
    if !is_visible {
        timers.remove(id);
        return Ok(());
    }
    let row:Option<(String,String,i64)>=conn.query_row("SELECT owner_window,source_ref,created_at FROM soul_output_observations WHERE output_id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|_|crate::error_codes::LEDGER_UNREADABLE)?;
    let Some((expected, raw, created)) = row else {
        return Ok(());
    };
    if expected != owner {
        return Err(crate::error_codes::RECEIPT_SOURCE_INVALID.into());
    }
    let (_, start, last) = timers
        .entry(id.into())
        .or_insert((owner.into(), mono, mono));
    if mono.saturating_duration_since(*last) > Duration::from_secs(10) {
        *start = mono;
    }
    *last = mono;
    if mono.saturating_duration_since(*start) < Duration::from_secs(60) {
        return Ok(());
    }
    let source = serde_json::from_str(&raw).map_err(|_| crate::error_codes::INVALID_SOURCE)?;
    emit_output(conn, id, &source, "viewed", created, now)?;
    timers.remove(id);
    Ok(())
}
pub fn emit_output(
    conn: &mut Connection,
    id: &str,
    source: &SourceRef,
    evidence: &str,
    created: i64,
    now: i64,
) -> Result<(), String> {
    if !matches!(evidence, "viewed" | "favorited") {
        return Err(crate::error_codes::INVALID_EVIDENCE.into());
    }
    store::transaction(conn, |tx| {
        if !proactive::event_allowed(tx, ProactiveCategory::OutputFeedback, created)? {
            return Ok(());
        }
        let deleted: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM soul_source_tombstones WHERE source_id=?1)",
                [&source.id],
                |r| r.get(0),
            )
            .map_err(|_| crate::error_codes::LEDGER_UNREADABLE)?;
        if deleted {
            return Ok(());
        }
        tx.execute("UPDATE soul_output_observations SET observed_at=?2,evidence_kind=?3 WHERE output_id=?1 AND observed_at IS NULL",params![id,now,evidence]).map_err(|_|crate::error_codes::LEDGER_WRITE_FAILED)?;
        proactive::queue(
            tx,
            ProactiveMessage {
                id: format!("output-{id}"),
                category: ProactiveCategory::OutputFeedback,
                source: source.clone(),
                dedupe_key: format!("output:{}", source.id),
                template_id: format!("output_html_{evidence}"),
                valid_from: now,
                expires_at: now + 7200,
                state: DeliveryState::Pending,
            },
            now,
        )?;
        Ok(())
    })
}
pub fn produce_local(conn: &mut Connection, now: i64) -> Result<(), String> {
    let history = super::continuity::get(conn, now)?;
    if history.history_enabled && history.days >= 7 {
        let source = SourceRef {
            kind: "app_event".into(),
            id: format!("shared-week-{}", history.revision),
            revision: 1,
        };
        super::continuity::record_event(conn, "shared_week", &source, now, now)?;
    }

    store::transaction(conn, |tx| {
        if proactive::event_allowed(tx, ProactiveCategory::SmallTalk, now)?
            && !super::desktop::enabled(tx)?
        {
            let date = chrono::DateTime::<chrono::Utc>::from_timestamp(now, 0)
                .ok_or("invalid_clock")?
                .with_timezone(&chrono::Local)
                .date_naive()
                .to_string();
            proactive::queue(
                tx,
                ProactiveMessage {
                    id: format!("smalltalk-{date}"),
                    category: ProactiveCategory::SmallTalk,
                    source: SourceRef {
                        kind: "app_event".into(),
                        id: date.clone(),
                        revision: 1,
                    },
                    dedupe_key: format!("smalltalk:{date}"),
                    template_id: if now.rem_euclid(2) == 0 {
                        "small_talk_a"
                    } else {
                        "small_talk_b"
                    }
                    .into(),
                    valid_from: now,
                    expires_at: now + 7200,
                    state: DeliveryState::Pending,
                },
                now,
            )?;
        }
        if !proactive::event_allowed(tx, ProactiveCategory::Pattern, now)? {
            return Ok(());
        }
        let topics = super::open_loops::list(tx, None)?;
        let mut groups: HashMap<u32, Vec<&OpenLoop>> = HashMap::new();
        use chrono::{Datelike, TimeZone};
        for topic in &topics {
            if !matches!(
                topic.state,
                OpenLoopState::Tracking | OpenLoopState::Due | OpenLoopState::Closed
            ) {
                continue;
            }
            let Some(start) = topic.time.starts_at else {
                continue;
            };
            let Ok(zone) = topic.time.timezone.parse::<chrono_tz::Tz>() else {
                continue;
            };
            let Some(date) = zone.timestamp_opt(start, 0).single() else {
                continue;
            };
            groups
                .entry(date.weekday().num_days_from_monday())
                .or_default()
                .push(topic);
        }
        for (day, group) in groups {
            let dates: std::collections::HashSet<_> = group
                .iter()
                .filter_map(|t| {
                    t.time
                        .timezone
                        .parse::<chrono_tz::Tz>()
                        .ok()?
                        .timestamp_opt(t.time.starts_at?, 0)
                        .single()
                        .map(|at| at.date_naive())
                })
                .collect();
            if dates.len() < 3 {
                continue;
            }
            let mut ids: Vec<_> = group.iter().map(|t| t.id.as_str()).collect();
            ids.sort();
            let id = format!("pattern-{day}-{}", ids[0]);
            let baseline: i64 = tx
                .query_row(
                    "SELECT enabled_since FROM soul_category_baselines WHERE category='pattern'",
                    [],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|_| crate::error_codes::LEDGER_UNREADABLE)?
                .unwrap_or(0);
            // Historical topics are not scanned into fresh observations after enabling.
            let mut recent = false;
            for topic in &group {
                recent |= tx
                    .query_row(
                        "SELECT updated_at>=?2 AND updated_at<=?3 FROM soul_open_loops WHERE id=?1",
                        params![topic.id, baseline, now],
                        |r| r.get::<_, bool>(0),
                    )
                    .map_err(|_| crate::error_codes::LEDGER_UNREADABLE)?;
            }
            if !recent {
                continue;
            }

            for topic in &group {
                tx.execute(
                    "INSERT INTO soul_observation_sources VALUES(?1,?2) ON CONFLICT DO NOTHING",
                    params![id, topic.source.id],
                )
                .map_err(|_| crate::error_codes::LEDGER_WRITE_FAILED)?;
            }
            proactive::queue(
                tx,
                ProactiveMessage {
                    id: id.clone(),
                    category: ProactiveCategory::Pattern,
                    source: SourceRef {
                        kind: "open_loop".into(),
                        id: group[0].id.clone(),
                        revision: group[0].revision,
                    },
                    dedupe_key: id,
                    template_id: "pattern_confirmed_plans".into(),
                    valid_from: now,
                    expires_at: now + 7200,
                    state: DeliveryState::Pending,
                },
                now,
            )?;
        }
        Ok(())
    })
}
/// Deterministic advisory only: overlap, >8 planned hours, or >6 events in a batch.
pub fn schedule_advice(events: &[(u64, u64)], locale: &str) -> Option<&'static str> {
    let mut sorted = events.to_vec();
    sorted.sort_unstable();
    let overlap = sorted.windows(2).any(|w| w[0].1 > w[1].0);
    let total: u64 = events
        .iter()
        .map(|(start, end)| end.saturating_sub(*start))
        .sum();
    if !overlap && total <= 8 * 3600 && events.len() <= 6 {
        return None;
    }
    Some(match locale{"en-US"=>"This plan has overlapping times, over eight planned hours, or more than six items. Consider leaving a little space between them.","ja-JP"=>"予定の重複、合計8時間超、または6件超の予定があります。少し余白を設けてもよさそうです。",_=>"这批安排存在时间重叠、总时长超过8小时或超过6项；可以考虑留一点余量。"})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        store::migrate(&mut c).unwrap();
        c.execute("INSERT INTO soul_control(singleton,revision,enabled,paused,enabled_since,cleared_through,category_settings) VALUES(1,1,1,0,0,0,'[{\"category\":\"output_feedback\",\"enabled\":true}]')",[]).unwrap();
        c
    }
    #[test]
    fn sixty_seconds_requires_continuous_fresh_native_visibility() {
        let mut c = db();
        register_preview(&mut c, "preview", "bubble", "source", 100).unwrap();
        let visibility = PreviewVisibility::default();
        let at = Instant::now();
        visible(&mut c, &visibility, "preview", "bubble", true, 100, at).unwrap();
        // Missing heartbeats cannot manufacture dwell time.
        visible(
            &mut c,
            &visibility,
            "preview",
            "bubble",
            true,
            160,
            at + Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(
            c.query_row("SELECT count(*) FROM soul_proactive_ledger", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        for i in 1..=12 {
            visible(
                &mut c,
                &visibility,
                "preview",
                "bubble",
                true,
                160 + i * 5,
                at + Duration::from_secs((60 + i * 5) as u64),
            )
            .unwrap();
        }
        assert_eq!(
            c.query_row("SELECT count(*) FROM soul_proactive_ledger", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(visible(&mut c, &visibility, "preview", "panel", true, 230, at).is_err());
    }
    #[test]
    fn deleted_sources_and_disabled_events_never_replay() {
        let mut c = db();
        let source = SourceRef {
            kind: "chat_session".into(),
            id: "source".into(),
            revision: 1,
        };
        super::super::lifecycle::delete_sources(&mut c, &["source".into()], 100).unwrap();
        emit_output(&mut c, "one", &source, "favorited", 101, 101).unwrap();
        assert_eq!(
            c.query_row("SELECT count(*) FROM soul_proactive_ledger", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        c.execute("UPDATE soul_control SET enabled=0", []).unwrap();
        register_preview(&mut c, "two", "bubble", "new", 102).unwrap();
        assert_eq!(
            c.query_row("SELECT count(*) FROM soul_output_observations", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
    }
    #[test]
    fn schedule_advice_does_not_trigger_for_ordinary_plan() {
        assert!(schedule_advice(&[(0, 3600), (7200, 10800)], "en-US").is_none());
        assert!(schedule_advice(&[(0, 3600), (1800, 4000)], "en-US").is_some());
        assert!(schedule_advice(&[(0, 9 * 3600)], "ja-JP").is_some());
        assert!(schedule_advice(&[(0, 0); 7], "zh-CN").is_some());
    }
}

#[cfg(test)]
mod local_tests {
    use super::*;
    #[test]
    fn local_templates_are_off_by_default_and_share_existing_queue_dedupe() {
        let mut c = Connection::open_in_memory().unwrap();
        store::migrate(&mut c).unwrap();
        super::super::settings::get(&mut c, 100).unwrap();
        produce_local(&mut c, 101).unwrap();
        assert_eq!(
            c.query_row("SELECT count(*) FROM soul_proactive_ledger", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        c.execute("UPDATE soul_control SET enabled=1,category_settings='[{\"category\":\"small_talk\",\"enabled\":true}]'",[]).unwrap();
        produce_local(&mut c, 101).unwrap();
        produce_local(&mut c, 102).unwrap();
        assert_eq!(
            c.query_row("SELECT count(*) FROM soul_proactive_ledger", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}
