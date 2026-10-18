//! P1 deterministic expression state. No model-facing mutation tool exists.
use super::{model::SourceRef, store};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
const DECAY: i64 = 1800;
const RULE_VERSION: i64 = 1;
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mood {
    Calm,
    Happy,
    Stifled,
    Energized,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Scores {
    values: BTreeMap<Mood, u8>,
    last_event: BTreeMap<Mood, i64>,
}
impl Default for Scores {
    fn default() -> Self {
        Self {
            values: BTreeMap::new(),
            last_event: BTreeMap::new(),
        }
    }
}
#[derive(Debug, Clone)]
pub struct State {
    pub mood: Mood,
    scores: Scores,
    last_decay: i64,
}
fn select(scores: &Scores, current: Mood) -> Mood {
    let max = scores.values.values().copied().max().unwrap_or(0);
    if max < 2 {
        return Mood::Calm;
    }
    if scores.values.get(&current) == Some(&max) {
        return current;
    }
    scores
        .values
        .iter()
        .filter(|(_, score)| **score == max)
        .max_by_key(|(mood, _)| (scores.last_event.get(mood).copied().unwrap_or(0), **mood))
        .map(|(mood, _)| *mood)
        .unwrap_or(Mood::Calm)
}
fn load(conn: &Connection, now: i64) -> Result<State, String> {
    let row:Option<(String,String,i64,i64)>=conn.query_row("SELECT scores,current_mood,last_decay_at,rule_version FROM soul_mood_snapshot WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(|_| "mood_unreadable")?;
    let mut state = match row {
        None => State {
            mood: Mood::Calm,
            scores: Scores::default(),
            last_decay: now,
        },
        Some((scores, mood, last_decay, version)) => {
            if version != RULE_VERSION {
                return Err("mood_rule_mismatch".into());
            }
            let scores: Scores = serde_json::from_str(&scores).map_err(|_| "mood_unreadable")?;
            if scores.values.values().any(|score| *score > 3) {
                return Err("mood_unreadable".into());
            }
            State {
                mood: serde_json::from_value(serde_json::Value::String(mood))
                    .map_err(|_| "mood_unreadable")?,
                scores,
                last_decay,
            }
        }
    };
    let steps = now.saturating_sub(state.last_decay).max(0) / DECAY;
    if steps > 0 {
        for score in state.scores.values.values_mut() {
            *score = score.saturating_sub(steps.min(3) as u8)
        }
        state.last_decay += steps * DECAY;
    }
    state.mood = select(&state.scores, state.mood);
    Ok(state)
}
fn save(conn: &Connection, state: &State) -> Result<(), String> {
    let name = serde_json::to_value(state.mood).map_err(|_| "mood_write_failed")?;
    conn.execute("INSERT INTO soul_mood_snapshot VALUES(1,?1,?2,?3,?4) ON CONFLICT(singleton) DO UPDATE SET rule_version=excluded.rule_version,scores=excluded.scores,current_mood=excluded.current_mood,last_decay_at=excluded.last_decay_at",params![RULE_VERSION,serde_json::to_string(&state.scores).map_err(|_| "mood_write_failed")?,name.as_str(),state.last_decay]).map_err(|_| "mood_write_failed")?;
    Ok(())
}
fn enabled(conn: &Connection) -> Result<bool, String> {
    conn.query_row(
        "SELECT mood_enabled FROM soul_control WHERE singleton=1",
        [],
        |r| r.get(0),
    )
    .optional()
    .map_err(|_| "mood_unreadable".to_string())
    .map(|value| value.unwrap_or(false))
}
pub fn snapshot(conn: &mut Connection, now: i64) -> Result<Mood, String> {
    if !enabled(conn)? {
        return Ok(Mood::Calm);
    }
    store::transaction(conn, |tx| {
        let state = load(tx, now)?;
        save(tx, &state)?;
        Ok(state.mood)
    })
}
/// Only trusted task commits or exact direct user phrases may call this entry.
pub(crate) fn event(
    conn: &mut Connection,
    kind: &str,
    source: &SourceRef,
    occurred_at: i64,
    now: i64,
) -> Result<Mood, String> {
    if !enabled(conn)? {
        return Ok(Mood::Calm);
    }
    let target = match kind {
        "task_success" | "praise" => Mood::Happy,
        "task_failure" | "task_interrupted" => Mood::Stifled,
        "practice_enabled" => Mood::Energized,
        _ => return snapshot(conn, now),
    };
    store::transaction(conn, |tx| {
        let mut state = load(tx, now)?;
        let baseline = tx
            .query_row(
                "SELECT cleared_through FROM soul_domain_baselines WHERE domain='mood'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .optional()
            .map_err(|_| "mood_unreadable")?
            .unwrap_or(0);
        if occurred_at <= baseline
            || occurred_at < now - 86400
            || occurred_at > now
            || now < state.last_decay
        {
            return Ok(state.mood);
        }
        let key = format!("mood:{kind}:{}:{}", source.id, source.revision);
        let last = tx
            .query_row(
                "SELECT max(occurred_at) FROM soul_events WHERE kind=?1",
                [format!("mood:{kind}")],
                |r| r.get::<_, Option<i64>>(0),
            )
            .map_err(|_| "mood_unreadable")?;
        let fresh=tx.execute("INSERT INTO soul_events(dedupe_key,kind,source_ref,occurred_at) VALUES(?1,?2,?3,?4) ON CONFLICT(dedupe_key) DO NOTHING",params![key,format!("mood:{kind}"),serde_json::to_string(source).map_err(|_| "mood_write_failed")?,occurred_at]).map_err(|_| "mood_write_failed")?;
        if fresh == 1 && last.is_none_or(|last| occurred_at >= last + 60) {
            let score = state.scores.values.entry(target).or_insert(0);
            *score = (*score + 1).min(3);
            state.scores.last_event.insert(target, occurred_at);
            state.mood = select(&state.scores, state.mood);
        }
        save(tx, &state)?;
        tx.execute(
            "DELETE FROM soul_events WHERE kind LIKE 'mood:%' AND occurred_at<?1",
            [now - 86400],
        )
        .map_err(|_| "mood_write_failed")?;
        Ok(state.mood)
    })
}
pub fn direct_user_event(text: &str) -> Option<&'static str> {
    let text = text.trim().trim_end_matches(['。', '！', '!', '.']);
    match text {
        "谢谢你" | "谢谢" | "做得很好" | "干得漂亮" | "thank you" | "good job" | "ありがとう" => {
            Some("praise")
        }
        _ => None,
    }
}
pub fn phrase(mood: Mood, locale: &str) -> &'static str {
    match (locale,mood) {
        (_,Mood::Calm)=>"",
        ("en-US",Mood::Happy)=>"Expression: a little upbeat; keep factual and respect the user's requested tone.",
        ("en-US",Mood::Stifled)=>"Expression: calm and matter-of-fact after a setback. Never blame the user or request comfort.",
        ("en-US",Mood::Energized)=>"Expression: focused and encouraging. Do not change task priorities or permissions.",
        ("ja-JP",Mood::Happy)=>"少し明るい話し方。事実とユーザー指定の語調を優先する。",
        ("ja-JP",Mood::Stifled)=>"落ち着いて事実を伝える。ユーザーを責めたり慰めを求めたりしない。",
        ("ja-JP",Mood::Energized)=>"集中し、穏やかに励ます。タスクの優先度や権限は変更しない。",
        (_,Mood::Happy)=>"表达略带轻快，仍以事实和用户本轮语气要求为准。",
        (_,Mood::Stifled)=>"表达沉稳、就事论事。不责备用户，不要求安抚，不降低服务质量。",
        (_,Mood::Energized)=>"表达专注并适度鼓励。不改变任务优先级、事实判断和权限。",
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        store::migrate(&mut conn).unwrap();
        super::super::settings::get(&mut conn, 100).unwrap();
        conn.execute("UPDATE soul_control SET mood_enabled=1", [])
            .unwrap();
        conn
    }
    fn source(id: &str) -> SourceRef {
        SourceRef {
            kind: "agent_task".into(),
            id: id.into(),
            revision: 1,
        }
    }
    #[test]
    fn dedup_cooldown_decay_and_rollback_are_conservative() {
        let mut conn = db();
        assert_eq!(
            event(&mut conn, "task_success", &source("a"), 100, 100).unwrap(),
            Mood::Calm
        );
        assert_eq!(
            event(&mut conn, "task_success", &source("a"), 100, 200).unwrap(),
            Mood::Calm
        );
        assert_eq!(
            event(&mut conn, "task_success", &source("b"), 120, 200).unwrap(),
            Mood::Calm
        );
        assert_eq!(
            event(&mut conn, "task_success", &source("c"), 200, 200).unwrap(),
            Mood::Happy
        );
        assert_eq!(
            event(&mut conn, "task_failure", &source("back"), 50, 50).unwrap(),
            Mood::Happy
        );
        assert_eq!(snapshot(&mut conn, 200 + DECAY).unwrap(), Mood::Calm);
        assert_eq!(snapshot(&mut conn, 10000).unwrap(), Mood::Calm);
    }
    #[test]
    fn cancellation_and_quoted_praise_have_no_negative_event() {
        assert_eq!(direct_user_event("他说谢谢你"), None);
        assert_eq!(direct_user_event("start practice"), None);
        assert_eq!(direct_user_event("谢谢你！"), Some("praise"));
        let mut conn = db();
        assert_eq!(
            event(&mut conn, "cancelled", &source("cancel"), 100, 100).unwrap(),
            Mood::Calm
        );
    }
    #[test]
    fn disable_suppresses_prompt_and_does_not_replay_old_events() {
        let mut conn = db();
        event(&mut conn, "task_success", &source("a"), 100, 100).unwrap();
        event(&mut conn, "task_success", &source("b"), 200, 200).unwrap();
        conn.execute("UPDATE soul_control SET mood_enabled=0", [])
            .unwrap();
        assert_eq!(snapshot(&mut conn, 200).unwrap(), Mood::Calm);
        assert_eq!(phrase(Mood::Calm, "zh-CN"), "");
    }
}
