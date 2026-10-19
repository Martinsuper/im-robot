//! Explicit plans are review candidates, never inferred facts or scheduled messages.
use super::{model::*, store};
use crate::memory::policy;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

const KIND: &str = "open_loop";
const UNPARSED_VERSION: &str = "unparsed-1";

fn normalize(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

fn time_expression(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    [
        "下周末",
        "本周末",
        "这个周末",
        "下个月",
        "这个月",
        "next weekend",
        "next month",
        "next week",
        "this weekend",
        "tomorrow",
        "tonight",
        "週末",
        "来週",
        "来月",
        "明日",
        "明天",
        "后天",
        "明晚",
        "明早",
        "今晚",
        "今天",
        "下周",
        "这周",
        "本周",
        "周末",
        "下月",
        "明年",
        "今年",
    ]
    .iter()
    .find(|phrase| lower.contains(**phrase))
    .map(|phrase| (*phrase).to_string())
}

fn explicit_plan(statement: &str) -> bool {
    let lower = statement.to_lowercase();
    // Prefer missed candidates to recording a quoted, hypothetical, cancelled,
    // third-party, or interrogative statement as the user's commitment.
    if statement.chars().count() < 5
        || statement.chars().count() > 500
        || statement.contains(['?', '？', '"', '“', '”', '「', '」', '『', '』', '`'])
        || [
            "如果",
            "假如",
            "假设",
            "要是",
            "可能",
            "也许",
            "或许",
            "例如",
            "比如",
            "应该",
            "希望",
            "他说",
            "她说",
            "你说",
            "用户说",
            "翻译",
            "举例",
            "示例",
            "吗",
            "是否",
            "能否",
            "怎么",
            "如何",
            "不确定",
            "没想好",
            "还没决定",
            "想想",
            "不打算",
            "不准备",
            "不想",
            "取消",
            "不去了",
            "帮我",
            "帮你",
            "让你",
            "请你",
            "告诉我",
        ]
        .iter()
        .any(|word| lower.contains(word))
        || [
            "if ",
            "maybe ",
            "perhaps ",
            "for example",
            "he said",
            "she said",
            "you said",
            "i don't",
            "i do not",
            "not going to",
            "want to know",
            "want to ask",
            "want you to",
            "help me",
            "tell me",
            "予定はない",
            "かもしれ",
            "例えば",
            "と言った",
            "と言って",
            "ですか",
            "ますか",
            "たいですか",
        ]
        .iter()
        .any(|word| lower.contains(word))
    {
        return false;
    }
    let strong = [
        "我计划",
        "我打算",
        "我准备",
        "我决定",
        "我们计划",
        "我们打算",
        "我们准备",
        "我们决定",
        "i plan to ",
        "i intend to ",
        "i am planning to ",
        "i'm planning to ",
        "i will ",
        "we plan to ",
        "we intend to ",
        "we will ",
    ];
    for marker in strong {
        if let Some(rest) = lower.strip_prefix(marker) {
            let rest = rest.trim();
            return !rest.is_empty()
                && !["好了", "好啦", "的", "不"]
                    .iter()
                    .any(|word| rest.starts_with(word));
        }
    }
    if let Some(rest) = lower
        .strip_prefix("我想")
        .or_else(|| lower.strip_prefix("我要"))
        .or_else(|| lower.strip_prefix("我们要"))
    {
        let rest = rest.trim();
        if rest.starts_with(['你', '他', '她'])
            || rest.starts_with("知道")
            || rest.starts_with("了解")
            || rest.starts_with("问")
        {
            return false;
        }
        return [
            "去", "做", "完成", "发布", "学习", "学", "整理", "联系", "参加", "提交", "开始", "读",
            "写", "买", "跑", "练", "准备", "安排", "报名", "旅行", "搬", "换", "转", "考", "更新",
            "修", "处理", "预约",
        ]
        .iter()
        .any(|action| rest.contains(action));
    }
    if let Some(rest) = lower
        .strip_prefix("i want to ")
        .or_else(|| lower.strip_prefix("we want to "))
    {
        return !rest.trim().is_empty();
    }
    for prefix in [
        "下周末",
        "本周末",
        "下个月",
        "这个月",
        "明天",
        "后天",
        "明晚",
        "明早",
        "今晚",
        "今天",
        "下周",
        "这周",
        "本周",
        "周末",
        "下月",
        "明年",
        "今年",
    ] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            let rest = rest.trim();
            // A subject may sit between the time phrase and the intention:
            // "下周末我要去爬山", "next month we plan to move".
            let rest = rest
                .strip_prefix("我们")
                .or_else(|| rest.strip_prefix("我"))
                .or_else(|| rest.strip_prefix("i "))
                .or_else(|| rest.strip_prefix("we "))
                .unwrap_or(rest)
                .trim();
            return [
                "要",
                "打算",
                "计划",
                "准备",
                "will ",
                "plan to ",
                "intend to ",
            ]
            .iter()
            .any(|marker| rest.starts_with(marker));
        }
    }
    // Japanese plans need both a direct subject/time lead-in and an intention.
    ["私は", "わたしは", "来週", "来月", "明日", "週末"]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
        && ["予定です", "予定だ", "つもりです", "つもりだ"]
            .iter()
            .any(|marker| lower.ends_with(marker))
}

pub(crate) fn candidates_from_user(
    entry: &crate::chat_session::ChatHistoryEntry,
    now: i64,
    timezone: &str,
) -> Vec<OpenLoopCandidate> {
    if entry.id.is_empty()
        || timezone.is_empty()
        || policy::contains_sensitive_content(&entry.prompt)
    {
        return vec![];
    }
    let Ok(baseline) = i64::try_from(entry.created_at) else {
        return vec![];
    };
    entry
        .prompt
        .split(['。', '！', '!', '\n', ';', '；', '.'])
        .map(str::trim)
        .filter(|statement| explicit_plan(statement))
        .map(|statement| {
            let fingerprint = format!(
                "{:x}",
                Sha256::digest(format!("{}\0{}", entry.id, normalize(statement)).as_bytes())
            );
            OpenLoopCandidate {
                id: format!("loop-candidate-{fingerprint}"),
                source: SourceRef {
                    kind: "chat_entry".into(),
                    id: entry.id.clone(),
                    revision: 1,
                },
                dedupe_key: format!("open_loop:{fingerprint}"),
                content: statement.into(),
                time: OpenLoopTime {
                    expression: time_expression(statement),
                    baseline,
                    timezone: timezone.into(),
                    starts_at: None,
                    ends_at: None,
                    parser_version: UNPARSED_VERSION.into(),
                },
                status: CandidateStatus::PendingReview,
                created_at: now,
                reviewed_at: None,
            }
        })
        .collect()
}

/// Parser version for concrete windows fixed by an explicit manual edit (S05).
pub const MANUAL_PARSER_VERSION: &str = "manual-1";

#[cfg(test)]
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - ((m <= 2) as i64);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = m + if m > 2 { -3 } else { 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

pub(crate) fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = y + ((m <= 2) as i64);
    (y, m, d)
}

/// Calendar boundaries are computed in the source timezone, including DST.
fn calendar_bounds(
    expression: &str,
    date: chrono::NaiveDate,
) -> Option<(chrono::NaiveDateTime, chrono::NaiveDateTime)> {
    use chrono::{Datelike, Duration, NaiveDate};
    let monday = date.checked_sub_signed(Duration::days(i64::from(
        date.weekday().num_days_from_monday(),
    )))?;
    let lower = expression.trim().to_lowercase();
    if let Ok(date) = NaiveDate::parse_from_str(&lower, "%Y-%m-%d") {
        return Some((
            date.and_hms_opt(0, 0, 0)?,
            date.checked_add_signed(Duration::days(1))?
                .and_hms_opt(0, 0, 0)?,
        ));
    }
    let (first, after, hour) = match lower.as_str() {
        "周末" | "本周末" | "这个周末" | "this weekend" | "週末" => {
            (monday + Duration::days(5), monday + Duration::days(7), 0)
        }
        "下周末" | "next weekend" => {
            (monday + Duration::days(12), monday + Duration::days(14), 0)
        }
        "下周" | "next week" | "来週" => {
            (monday + Duration::days(7), monday + Duration::days(14), 0)
        }
        "明天" | "明日" | "tomorrow" => (date + Duration::days(1), date + Duration::days(2), 0),
        "后天" => (date + Duration::days(2), date + Duration::days(3), 0),
        "今晚" | "tonight" => (date, date + Duration::days(1), 18),
        "明晚" => (date + Duration::days(1), date + Duration::days(2), 18),
        "下个月" | "next month" | "来月" => {
            let (year, month) = if date.month() == 12 {
                (date.year() + 1, 1)
            } else {
                (date.year(), date.month() + 1)
            };
            let first = NaiveDate::from_ymd_opt(year, month, 1)?;
            let (year2, month2) = if month == 12 {
                (year + 1, 1)
            } else {
                (year, month + 1)
            };
            (first, NaiveDate::from_ymd_opt(year2, month2, 1)?, 0)
        }
        _ => return None,
    };
    Some((first.and_hms_opt(hour, 0, 0)?, after.and_hms_opt(0, 0, 0)?))
}

pub fn resolve_window(expression: &str, baseline: i64, offset: i64) -> Option<(i64, i64)> {
    use chrono::TimeZone;
    let zone = chrono::FixedOffset::east_opt(i32::try_from(offset).ok()?)?;
    let date = zone.timestamp_opt(baseline, 0).single()?.date_naive();
    let (start, end) = calendar_bounds(expression, date)?;
    Some((
        zone.from_local_datetime(&start).single()?.timestamp(),
        zone.from_local_datetime(&end).single()?.timestamp() - 1,
    ))
}

pub fn resolve_time(time: &OpenLoopTime) -> Result<OpenLoopTime, String> {
    use chrono::TimeZone;
    let zone: chrono_tz::Tz = time.timezone.parse().map_err(|_| "invalid_loop_timezone")?;
    let mut result = time.clone();
    if result.starts_at.is_some() || result.ends_at.is_some() {
        match (result.starts_at, result.ends_at) {
            (Some(start), Some(end)) if start >= 0 && end >= start => {}
            _ => return Err("invalid_loop_time".into()),
        }
        return Ok(result);
    }
    if let Some(expression) = &time.expression {
        let date = zone
            .timestamp_opt(time.baseline, 0)
            .single()
            .ok_or("invalid_loop_time")?
            .date_naive();
        if let Some((start, end)) = calendar_bounds(expression, date) {
            if let (Some(start), Some(end)) = (
                zone.from_local_datetime(&start).single(),
                zone.from_local_datetime(&end).single(),
            ) {
                result.starts_at = Some(start.timestamp());
                result.ends_at = Some(end.timestamp() - 1);
            }
        }
    }
    result.parser_version = "calendar-iana-1".into();
    Ok(result)
}

#[cfg(test)]
fn month_days(year: i64, month: i64) -> (i64, i64) {
    let (year2, month2) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    (
        days_from_civil(year, month, 1),
        days_from_civil(year2, month2, 1) - 1,
    )
}

/// Called inside the existing extraction transaction, before its source marker.
pub(crate) fn enqueue(
    tx: &Transaction<'_>,
    entry: &crate::chat_session::ChatHistoryEntry,
    now: i64,
    timezone: &str,
) -> Result<usize, String> {
    let baseline = tx
        .query_row(
            "SELECT cleared_through FROM soul_domain_baselines WHERE domain='open_loops'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .optional()
        .map_err(|_| "storage_unavailable")?
        .unwrap_or(0);
    let deleted = tx
        .query_row(
            "SELECT 1 FROM soul_source_tombstones WHERE source_id=?1",
            [&entry.id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|_| "storage_unavailable")?
        .is_some();
    if deleted || (baseline > 0 && i64::try_from(entry.created_at).unwrap_or(0) <= baseline) {
        return Ok(0);
    }
    let mut added = 0;
    for candidate in candidates_from_user(entry, now, timezone) {
        let retired = tx
            .query_row(
                "SELECT 1 FROM soul_candidate_tombstones WHERE dedupe_key=?1",
                [&candidate.dedupe_key],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| "storage_unavailable")?
            .is_some();
        if retired {
            continue;
        }
        added += tx.execute("INSERT INTO soul_candidates(id,kind,source_ref,dedupe_key,payload,status,created_at) VALUES(?1,?2,?3,?4,?5,'pending_review',?6) ON CONFLICT(dedupe_key) DO NOTHING",
            params![candidate.id,KIND,serde_json::to_string(&candidate.source).map_err(|_| "candidate_invalid")?,candidate.dedupe_key,serde_json::to_string(&candidate).map_err(|_| "candidate_invalid")?,now])
            .map_err(|_| "topic_extraction_write_failed")?;
    }
    Ok(added)
}

fn decode_candidate(
    id: &str,
    status: &str,
    source: &str,
    dedupe: &str,
    payload: &str,
) -> Result<OpenLoopCandidate, String> {
    let candidate: OpenLoopCandidate =
        serde_json::from_str(payload).map_err(|_| "candidate_corrupt")?;
    let stored_source: SourceRef = serde_json::from_str(source).map_err(|_| "candidate_corrupt")?;
    let actual_status = serde_json::to_value(candidate.status).map_err(|_| "candidate_corrupt")?;
    if candidate.id != id
        || actual_status.as_str() != Some(status)
        || candidate.source != stored_source
        || candidate.dedupe_key != dedupe
    {
        return Err("candidate_corrupt".into());
    }
    let mut candidate = candidate;
    if matches!(candidate.status, CandidateStatus::PendingReview)
        && candidate.time.parser_version == UNPARSED_VERSION
    {
        candidate.time = resolve_time(&candidate.time)?;
    }
    Ok(candidate)
}

fn load_candidate(conn: &Connection, id: &str) -> Result<OpenLoopCandidate, String> {
    let row: Option<(String,String,String,String)> = conn.query_row("SELECT status,source_ref,dedupe_key,payload FROM soul_candidates WHERE id=?1 AND kind=?2",
        params![id,KIND], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(|_| "storage_unavailable")?;
    let (status, source, dedupe, payload) = row.ok_or("candidate_missing")?;
    decode_candidate(id, &status, &source, &dedupe, &payload)
}

fn similar(a: &str, b: &str) -> bool {
    let a = normalize(a);
    let b = normalize(b);
    if a == b {
        return true;
    }
    fn pairs(value: &str) -> HashSet<String> {
        value
            .chars()
            .collect::<Vec<_>>()
            .windows(2)
            .map(|pair| pair.iter().collect())
            .collect()
    }
    if a.chars().count() < 6 || b.chars().count() < 6 {
        return false;
    }
    let (a, b) = (pairs(&a), pairs(&b));
    a.intersection(&b).count() * 2 >= a.union(&b).count()
}

pub fn pending(conn: &Connection) -> Result<OpenLoopReviewQueue, String> {
    store::ensure_available(conn).map_err(|_| "storage_unavailable")?;
    let mut statement = conn.prepare("SELECT id,status,source_ref,dedupe_key,payload FROM soul_candidates WHERE kind=?1 AND status='pending_review' ORDER BY created_at,id LIMIT 100")
        .map_err(|_| "storage_unavailable")?;
    let rows = statement
        .query_map([KIND], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })
        .map_err(|_| "storage_unavailable")?;
    let mut candidates = vec![];
    for row in rows {
        let (id, status, source, dedupe, payload) = row.map_err(|_| "storage_unavailable")?;
        candidates.push(decode_candidate(&id, &status, &source, &dedupe, &payload)?);
    }
    let loops = list(conn, None)?;
    let active: Vec<_> = loops
        .iter()
        .filter(|item| matches!(item.state, OpenLoopState::Tracking | OpenLoopState::Due))
        .collect();
    let reviewed = candidates
        .iter()
        .map(|candidate| OpenLoopReviewCandidate {
            candidate: candidate.clone(),
            similar_candidate_ids: candidates
                .iter()
                .filter(|other| {
                    other.source.id != candidate.source.id
                        && similar(&candidate.content, &other.content)
                })
                .map(|other| other.id.clone())
                .collect(),
            similar_loop_ids: active
                .iter()
                .filter(|item| {
                    item.source.id != candidate.source.id
                        && similar(&candidate.content, &item.content)
                })
                .map(|item| item.id.clone())
                .collect(),
        })
        .collect();
    Ok(OpenLoopReviewQueue {
        candidates: reviewed,
        active_count: active.len() as u32,
        active_limit: MAX_ACTIVE_LOOPS,
    })
}

pub fn list(conn: &Connection, state: Option<OpenLoopState>) -> Result<Vec<OpenLoop>, String> {
    store::ensure_available(conn).map_err(|_| "storage_unavailable")?;
    let state = state.map(|state| {
        serde_json::to_value(state)
            .unwrap()
            .as_str()
            .unwrap()
            .to_string()
    });
    let mut statement = conn.prepare("SELECT id,revision,content,source_ref,time_expression,time_baseline,timezone,starts_at,ends_at,parser_version,state,closed_at FROM soul_open_loops WHERE (?1 IS NULL OR state=?1) ORDER BY created_at,id")
        .map_err(|_| "storage_unavailable")?;
    let mut rows = statement
        .query([state])
        .map_err(|_| "storage_unavailable")?;
    let mut result = vec![];
    while let Some(row) = rows.next().map_err(|_| "storage_unavailable")? {
        let item = (|| -> Result<OpenLoop, String> {
            Ok(OpenLoop {
                id: row.get(0).map_err(|_| "topic_corrupt")?,
                revision: row.get(1).map_err(|_| "topic_corrupt")?,
                content: row.get(2).map_err(|_| "topic_corrupt")?,
                source: serde_json::from_str(
                    &row.get::<_, String>(3).map_err(|_| "topic_corrupt")?,
                )
                .map_err(|_| "topic_corrupt")?,
                time: OpenLoopTime {
                    expression: row.get(4).map_err(|_| "topic_corrupt")?,
                    baseline: row.get(5).map_err(|_| "topic_corrupt")?,
                    timezone: row.get(6).map_err(|_| "topic_corrupt")?,
                    starts_at: row.get(7).map_err(|_| "topic_corrupt")?,
                    ends_at: row.get(8).map_err(|_| "topic_corrupt")?,
                    parser_version: row.get(9).map_err(|_| "topic_corrupt")?,
                },
                state: serde_json::from_value(serde_json::Value::String(
                    row.get(10).map_err(|_| "topic_corrupt")?,
                ))
                .map_err(|_| "topic_corrupt")?,
                closed_at: row.get(11).map_err(|_| "topic_corrupt")?,
            })
        })()?;
        result.push(item);
    }
    Ok(result)
}

pub fn review(
    conn: &mut Connection,
    input: ReviewOpenLoopInput,
    now: i64,
) -> Result<Option<OpenLoop>, String> {
    if matches!(input.decision, CandidateStatus::PendingReview) {
        return Err("invalid_review".into());
    }
    store::transaction(conn, |tx| {
        let mut candidate = load_candidate(tx, &input.candidate_id)?;
        if !matches!(candidate.status, CandidateStatus::PendingReview) {
            if matches!(
                (candidate.status, input.decision),
                (CandidateStatus::Approved, CandidateStatus::Approved)
            ) {
                let loop_id = format!("loop-{}", candidate.id);
                return list(tx, None)?
                    .into_iter()
                    .find(|item| item.id == loop_id)
                    .map(Some)
                    .ok_or("topic_missing".into());
            }
            if matches!(
                (candidate.status, input.decision),
                (CandidateStatus::Rejected, CandidateStatus::Rejected)
            ) {
                return Ok(None);
            }
            return Err("candidate_reviewed".into());
        }
        let approved = matches!(input.decision, CandidateStatus::Approved);
        if approved {
            if let Some(time) = &input.time {
                let mut time = time.clone();
                time.baseline = candidate.time.baseline;
                candidate.time = resolve_time(&time)?;
                candidate.time.parser_version = MANUAL_PARSER_VERSION.into();
            }
            if let Some(content) = &input.content {
                candidate.content = content.trim().to_string();
            }
            if candidate.content.is_empty()
                || candidate.content.chars().count() > 500
                || candidate
                    .content
                    .chars()
                    .any(|c| c.is_control() && c != '\n' && c != '\t')
            {
                return Err("invalid_topic".into());
            }
            if policy::contains_sensitive_content(&candidate.content) {
                return Err("sensitive_topic".into());
            }
            let active: u32 = tx
                .query_row(
                    "SELECT count(*) FROM soul_open_loops WHERE state IN ('tracking','due')",
                    [],
                    |r| r.get(0),
                )
                .map_err(|_| "storage_unavailable")?;
            if active >= MAX_ACTIVE_LOOPS {
                return Err("open_loop_limit".into());
            }
            tx.execute("INSERT INTO soul_open_loops(id,revision,content,source_ref,candidate_id,time_expression,time_baseline,timezone,starts_at,ends_at,parser_version,state,created_at,updated_at) VALUES(?1,1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'tracking',?11,?11)",
                params![format!("loop-{}",candidate.id),candidate.content,serde_json::to_string(&candidate.source).map_err(|_| "candidate_corrupt")?,candidate.id,candidate.time.expression,candidate.time.baseline,candidate.time.timezone,candidate.time.starts_at,candidate.time.ends_at,candidate.time.parser_version,now])
                .map_err(|_| "storage_write_failed")?;
        }
        candidate.status = input.decision;
        candidate.reviewed_at = Some(now);
        let status = if approved { "approved" } else { "rejected" };
        let changed = tx.execute("UPDATE soul_candidates SET status=?2,reviewed_at=?3,payload=?4 WHERE id=?1 AND status='pending_review'",
            params![candidate.id,status,now,serde_json::to_string(&candidate).map_err(|_| "candidate_corrupt")?]).map_err(|_| "storage_write_failed")?;
        if changed != 1 {
            return Err("candidate_reviewed".into());
        }
        if approved {
            let id = format!("loop-{}", candidate.id);
            list(tx, None)?
                .into_iter()
                .find(|item| item.id == id)
                .map(Some)
                .ok_or("topic_missing".into())
        } else {
            Ok(None)
        }
    })
}

/// Allowed lifecycle transitions. `due` is scheduled (P0 manual or, later,
/// scheduler-set); terminal states reopen only through this same command.
fn transition_allowed(from: OpenLoopState, to: OpenLoopState) -> bool {
    use OpenLoopState::*;
    match (from, to) {
        (a, b) if a == b => true,
        (Tracking, Closed) | (Tracking, Cancelled) => true,
        (Due, Closed) | (Due, Cancelled) => true,
        (Closed | Cancelled | Expired, Tracking) => true,
        _ => false,
    }
}

fn validate_topic_content(content: &str) -> Result<(), String> {
    if content.is_empty() || content.chars().count() > 500 {
        return Err("invalid_topic".into());
    }
    if content
        .chars()
        .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err("invalid_topic".into());
    }
    if policy::contains_sensitive_content(content) {
        return Err("sensitive_topic".into());
    }
    Ok(())
}

/// Manual lifecycle management (S05). Any accepted change bumps the revision
/// exactly once; moving to a terminal state or reschedule revokes proactive
/// messages of this topic that are still queued or visible.
pub fn update(
    conn: &mut Connection,
    input: UpdateOpenLoopInput,
    now: i64,
) -> Result<OpenLoop, String> {
    if input.content.is_none() && input.time.is_none() && input.state.is_none() {
        return Err("no_changes".into());
    }
    if let Some(content) = &input.content {
        validate_topic_content(content)?;
    }
    if let Some(time) = &input.time {
        if time.timezone.parse::<chrono_tz::Tz>().is_err() || time.baseline < 0 {
            return Err("invalid_loop_time".into());
        }
        match (time.starts_at, time.ends_at) {
            (Some(starts), Some(ends)) if starts >= 0 && ends >= starts => {}
            (None, None) => {}
            _ => return Err("invalid_loop_time".into()),
        }
    }
    store::transaction(conn, |tx| {
        type LoopRow = (
            i64,
            String,
            Option<i64>,
            Option<i64>,
            Option<String>,
            i64,
            String,
            String,
            String,
        );
        let row: Option<LoopRow> =
            tx.query_row(
                "SELECT revision,content,starts_at,ends_at,time_expression,time_baseline,timezone,state,parser_version FROM soul_open_loops WHERE id=?1",
                params![&input.id],
                |r| {
                    Ok((
                        r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?,
                        r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?
                    ))
                },
            )
            .optional()
            .map_err(|_| "storage_unavailable")?;
        let (
            revision,
            mut content,
            mut starts,
            mut ends,
            mut expression,
            baseline,
            mut timezone,
            raw_state,
            parser_now,
        ) = row.ok_or("loop_missing")?;
        // expected_revision is a strict compare-and-swap value (-loops start at 1);
        // 0 is only a creation marker elsewhere and always stale here.
        if input.expected_revision != revision || input.expected_revision == 0 {
            return Err("loop_revision_conflict".into());
        }
        let state_now: OpenLoopState = serde_json::from_value(serde_json::Value::String(raw_state))
            .map_err(|_| "topic_corrupt")?;
        let mut state_next = input.state.unwrap_or(state_now);
        if !transition_allowed(state_now, state_next) {
            return Err("invalid_transition".into());
        }
        let mut parser_version = parser_now;
        if let Some(time) = &input.time {
            let anchored = OpenLoopTime {
                baseline,
                ..time.clone()
            };
            let resolved = resolve_time(&anchored)?;
            if starts != resolved.starts_at
                || ends != resolved.ends_at
                || timezone != resolved.timezone
            {
                starts = resolved.starts_at;
                ends = resolved.ends_at;
                expression = resolved.expression;
                timezone = resolved.timezone;
                parser_version = MANUAL_PARSER_VERSION.to_string();
                if state_next == OpenLoopState::Due {
                    state_next = OpenLoopState::Tracking;
                }
            }
        }
        if let Some(text) = &input.content {
            content = text.clone();
        }
        let terminal = matches!(
            state_next,
            OpenLoopState::Closed | OpenLoopState::Cancelled | OpenLoopState::Expired
        );
        if terminal {
            tx.execute(
                "UPDATE soul_proactive_ledger SET state='revoked', receipt_at=?2
                 WHERE state IN ('pending','dispatching','shown')
                 AND json_extract(source_ref,'$.id')=?1",
                params![&input.id, now],
            )
            .map_err(|_| "storage_write_failed")?;
        }
        let closed_at = if terminal { Some(now) } else { None };
        let revision_next = revision
            .checked_add(1)
            .ok_or("loop_revision_conflict".to_string())?;
        // An edited plan can invalidate any member of a multi-source pattern.
        // Withdraw conservatively rather than leave a stale aggregate visible.
        tx.execute("UPDATE soul_proactive_ledger SET state='revoked',receipt_at=?1 WHERE category='pattern' AND state IN ('pending','dispatching','shown')",[now]).map_err(|_|"storage_write_failed")?;
        let changed = tx.execute(
            "UPDATE soul_open_loops SET revision=?2, content=?3, starts_at=?4, ends_at=?5, time_expression=?6, time_baseline=?7, timezone=?8, parser_version=?9, state=?10, closed_at=?11, updated_at=?12 WHERE id=?13 AND revision=?14",
            params![
                &input.id, revision_next, content, starts, ends, expression, baseline, timezone,
                parser_version, state_to_sql(state_next), closed_at, now, &input.id, revision
            ],
        )
        .map_err(|_| "storage_write_failed")?;
        if changed != 1 {
            return Err("loop_revision_conflict".into());
        }
        Ok(())
    })?;
    list(conn, None)?
        .into_iter()
        .find(|item| item.id == input.id)
        .ok_or("loop_missing".into())
}

fn state_to_sql(state: OpenLoopState) -> String {
    serde_json::to_value(state)
        .unwrap()
        .as_str()
        .unwrap()
        .to_string()
}

/// S11 source-deletion linkage: removing a chat entry revokes anything the
/// soul system still queues or shows for that source and debts its candidates.
pub fn purge_for_source(conn: &mut Connection, source_id: &str, now: i64) -> Result<u64, String> {
    store::transaction(conn, |tx| {
        tx.execute(
            "UPDATE soul_proactive_ledger SET state='revoked', receipt_at=?1
             WHERE state IN ('pending','dispatching','shown')
             AND json_extract(source_ref,'$.id')=?2",
            params![now, source_id],
        )
        .map_err(|_| "ledger_unreadable".to_string())?;
        let candidates = tx
            .execute(
                "DELETE FROM soul_candidates WHERE json_extract(source_ref,'$.id')=?1",
                params![source_id],
            )
            .map_err(|_| "storage_write_failed".to_string())?;
        let loops = tx
            .execute(
                "DELETE FROM soul_open_loops WHERE json_extract(source_ref,'$.id')=?1",
                params![source_id],
            )
            .map_err(|_| "storage_write_failed".to_string())?;
        Ok(candidates as u64 + loops as u64)
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

    fn entry(id: &str, prompt: &str) -> crate::chat_session::ChatHistoryEntry {
        crate::chat_session::ChatHistoryEntry {
            id: id.into(),
            prompt: prompt.into(),
            response: String::new(),
            created_at: 100,
        }
    }

    fn enqueue(conn: &mut Connection, entry: &crate::chat_session::ChatHistoryEntry) -> usize {
        let tx = conn.transaction().unwrap();
        let added = super::enqueue(&tx, entry, 100, "Asia/Shanghai").unwrap();
        tx.commit().unwrap();
        added
    }

    fn review(
        conn: &mut Connection,
        id: &str,
        decision: CandidateStatus,
    ) -> Result<Option<OpenLoop>, String> {
        super::review(
            conn,
            ReviewOpenLoopInput {
                candidate_id: id.into(),
                decision,
                content: None,
                time: None,
            },
            200,
        )
    }

    fn pending_ids(conn: &Connection) -> Vec<String> {
        eprintln!("DEBUG pending_ids: {conn:?}");
        pending(conn)
            .unwrap()
            .candidates
            .iter()
            .map(|item| item.candidate.id.clone())
            .collect()
    }

    #[test]
    fn reprocessing_the_same_entry_does_not_generate_duplicates() {
        let mut conn = migrated();
        let plan = entry("a", "下周末我要去爬山。");
        assert_eq!(enqueue(&mut conn, &plan), 1);
        assert_eq!(pending_ids(&conn).len(), 1);
        enqueue(&mut conn, &plan);
        assert_eq!(pending_ids(&conn).len(), 1);
    }

    #[test]
    fn non_plans_and_sensitive_prompts_are_never_candidates() {
        let mut conn = migrated();
        let mix = entry(
            "a",
            "帮我写个工具。如果周五有空我可能会去爬山。我打算整理仓库。",
        );
        assert_eq!(enqueue(&mut conn, &mix), 1);
        let queue = pending(&conn).unwrap();
        assert_eq!(queue.candidates.len(), 1);
        assert_eq!(queue.candidates[0].candidate.content, "我打算整理仓库");
        // A sensitive prompt suppresses every candidate, not just the flagged sentence.
        assert_eq!(enqueue(&mut conn, &entry("b", "我打算整理密码本。")), 0);
    }

    #[test]
    fn rejected_candidates_cannot_be_revived_from_the_same_source() {
        let mut conn = migrated();
        let plan = entry("a", "我打算整理仓库。");
        assert_eq!(enqueue(&mut conn, &plan), 1);
        let id = pending_ids(&conn).remove(0);
        assert!(review(&mut conn, &id, CandidateStatus::Rejected)
            .unwrap()
            .is_none());
        assert!(pending_ids(&conn).is_empty());
        enqueue(&mut conn, &plan);
        assert!(pending_ids(&conn).is_empty());
        // Rejecting again on a repeated review keeps the stable terminal state.
        assert!(review(&mut conn, &id, CandidateStatus::Rejected)
            .unwrap()
            .is_none());
    }

    #[test]
    fn approval_and_topic_creation_commit_atomically() {
        let mut conn = migrated();
        enqueue(&mut conn, &entry("a", "我打算整理仓库。"));
        let id = pending_ids(&conn).remove(0);
        let item = review(&mut conn, &id, CandidateStatus::Approved)
            .unwrap()
            .unwrap();
        assert_eq!(item.id, format!("loop-{id}"));
        assert_eq!(item.state, OpenLoopState::Tracking);
        assert!(pending_ids(&conn).is_empty());
        // Repeated approval is idempotent and returns the existing topic.
        let again = review(&mut conn, &id, CandidateStatus::Approved).unwrap();
        assert_eq!(again.unwrap().id, item.id);
    }

    #[test]
    fn approval_respects_the_active_limit_and_fails_atomically() {
        let mut conn = migrated();
        let insert = "INSERT INTO soul_open_loops(id,revision,content,source_ref,time_baseline,timezone,parser_version,state,created_at,updated_at) VALUES(?1,1,'plan','{\"kind\":\"chat_entry\",\"id\":\"s\",\"revision\":1}',100,'Asia/Shanghai','1','tracking',100,100)";
        for i in 0..MAX_ACTIVE_LOOPS {
            conn.execute(insert, params![i.to_string()]).unwrap();
        }
        enqueue(&mut conn, &entry("a", "我打算整理仓库。"));
        let id = pending_ids(&conn).remove(0);
        assert_eq!(
            review(&mut conn, &id, CandidateStatus::Approved).unwrap_err(),
            "open_loop_limit"
        );
        assert_eq!(pending_ids(&conn).as_slice(), [id.as_str()]);
        conn.execute("UPDATE soul_open_loops SET state='closed' WHERE id='0'", [])
            .unwrap();
        assert!(review(&mut conn, &id, CandidateStatus::Approved)
            .unwrap()
            .is_some());
    }

    #[test]
    fn similar_sources_are_merged_suggestions_never_auto_merged() {
        let mut conn = migrated();
        enqueue(&mut conn, &entry("a", "我打算整理仓库。"));
        enqueue(&mut conn, &entry("b", "我打算整理仓库并贴标签。"));
        let queue = pending(&conn).unwrap();
        assert_eq!(queue.candidates.len(), 2);
        let (first, second) = (&queue.candidates[0], &queue.candidates[1]);
        assert!(first.similar_candidate_ids.contains(&second.candidate.id));
        assert!(second.similar_candidate_ids.contains(&first.candidate.id));
        // Approving one leaves the other as its own review item.
        let first_id = first.candidate.id.clone();
        review(&mut conn, &first_id, CandidateStatus::Approved)
            .unwrap()
            .unwrap();
        let rest = pending_ids(&conn);
        assert_eq!(rest.as_slice(), [second.candidate.id.as_str()]);
    }

    // ---------- S05 ----------

    const OFFSET: i64 = 28_800;
    const DAY: i64 = 86_400;

    fn ledger_row(id: &str, loop_id: &str, state: &str) -> String {
        format!(
            "INSERT INTO soul_proactive_ledger(id,category,source_ref,dedupe_key,template_id,valid_from,expires_at,state,created_at)
             VALUES('{id}','open_loop','{{\"kind\":\"open_loop\",\"id\":\"{loop_id}\",\"revision\":1}}','k-{id}','t',100,1000,'{state}',100);",
        )
    }

    fn connect() -> Connection {
        migrated()
    }

    #[test]
    fn resolve_window_covers_local_calendar_phrases() {
        // 1970-01-10 is a local Saturday; day arithmetic keeps this exact.
        let saturday = 9;
        let baseline = saturday * DAY - OFFSET; // local 00:00
        assert_eq!(
            resolve_window("周末", baseline, OFFSET),
            Some((
                saturday * DAY - OFFSET,
                (saturday + 1) * DAY - OFFSET + DAY - 1
            ))
        );
        // Next weekend is the following Saturday–Sunday.
        let next_sat = 16;
        assert_eq!(
            resolve_window("下周末", baseline, OFFSET),
            Some((
                next_sat * DAY - OFFSET,
                (next_sat + 1) * DAY - OFFSET + DAY - 1
            ))
        );
        assert_eq!(
            resolve_window("明天", baseline, OFFSET),
            Some((
                (saturday + 1) * DAY - OFFSET,
                (saturday + 1) * DAY - OFFSET + DAY - 1
            ))
        );
        // 今晚 still inside the running local day.
        assert_eq!(
            resolve_window("今晚", baseline, OFFSET),
            Some((
                saturday * DAY - OFFSET + 18 * 3600,
                (saturday + 1) * DAY - OFFSET - 1
            ))
        );
        // 下个月 spans the whole next natural month (February 1970 has 28 days).
        let (y, m, _) = civil_from_days(4);
        assert_eq!((y, m), (1970, 1));
        let (start_day, end_day) = month_days(1970, 2);
        assert_eq!(
            resolve_window("下个月", baseline, OFFSET),
            Some((start_day * DAY - OFFSET, end_day * DAY - OFFSET + DAY - 1))
        );
        assert_eq!(start_day, 31);
        assert_eq!(end_day, 58);
        // Vague or unknown expressions stay unscheduled.
        assert!(resolve_window("有空的时候", baseline, OFFSET).is_none());
        assert!(resolve_window("以后", baseline, OFFSET).is_none());
    }

    #[test]
    fn terminal_states_revoke_alive_messages_and_bump_revision_once() {
        let mut conn = connect();
        enqueue(&mut conn, &entry("a", "我打算整理仓库。"));
        let id = pending_ids(&conn).remove(0);
        let item = review(&mut conn, &id, CandidateStatus::Approved)
            .unwrap()
            .unwrap();
        let loop_id = item.id.clone();
        conn.execute_batch(&format!(
            "{}{}{}",
            ledger_row("m1", &loop_id, "pending"),
            ledger_row("m2", &loop_id, "shown"),
            ledger_row("m3", &loop_id, "responded")
        ))
        .unwrap();
        conn.execute_batch(&ledger_row("odd", "other-loop", "pending"))
            .unwrap();
        let updated = update(
            &mut conn,
            UpdateOpenLoopInput {
                id: loop_id.clone(),
                expected_revision: 1,
                content: None,
                time: None,
                state: Some(OpenLoopState::Cancelled),
            },
            300,
        )
        .unwrap();
        assert_eq!(updated.revision, 2);
        assert_eq!(updated.state, OpenLoopState::Cancelled);
        assert_eq!(updated.closed_at, Some(300));
        let state_of = |conn: &Connection, id: &str| {
            conn.query_row(
                "SELECT state FROM soul_proactive_ledger WHERE id=?1",
                [id],
                |r| r.get::<_, String>(0),
            )
            .unwrap()
        };
        assert_eq!(state_of(&conn, "m1"), "revoked");
        assert_eq!(state_of(&conn, "m2"), "revoked");
        assert_eq!(state_of(&conn, "m3"), "responded");
        assert_eq!(state_of(&conn, "odd"), "pending");
    }

    #[test]
    fn stale_updates_cannot_overwrite_newer_versions() {
        let mut conn = connect();
        enqueue(&mut conn, &entry("a", "我打算整理仓库。"));
        let id = pending_ids(&conn).remove(0);
        review(&mut conn, &id, CandidateStatus::Approved)
            .unwrap()
            .unwrap();
        let loop_id = format!("loop-{id}");
        let error = update(
            &mut conn,
            UpdateOpenLoopInput {
                id: loop_id.clone(),
                expected_revision: 0,
                content: Some("改过的内容".into()),
                time: None,
                state: None,
            },
            300,
        )
        .unwrap_err();
        assert_eq!(error, "loop_revision_conflict");
        let item = list(&conn, None).unwrap();
        assert_eq!(item.len(), 1);
        assert_eq!(item[0].content, "我打算整理仓库");
        assert_eq!(item[0].revision, 1);
    }

    #[test]
    fn invalid_transitions_are_rejected() {
        let mut conn = connect();
        enqueue(&mut conn, &entry("a", "我打算整理仓库。"));
        let id = pending_ids(&conn).remove(0);
        let item = review(&mut conn, &id, CandidateStatus::Approved)
            .unwrap()
            .unwrap();
        let loop_id = item.id.clone();
        let set = |conn: &mut Connection, state: OpenLoopState| {
            update(
                conn,
                UpdateOpenLoopInput {
                    id: loop_id.clone(),
                    expected_revision: 1,
                    content: None,
                    time: None,
                    state: Some(state),
                },
                300,
            )
        };
        assert!(set(&mut conn, OpenLoopState::Due).is_err()); // nothing scheduled yet
        assert!(set(&mut conn, OpenLoopState::Expired).is_err());
        assert!(set(&mut conn, OpenLoopState::PendingReview).is_err());
        update(
            &mut conn,
            UpdateOpenLoopInput {
                id: loop_id.clone(),
                expected_revision: 1,
                content: None,
                time: None,
                state: Some(OpenLoopState::Closed),
            },
            300,
        )
        .unwrap();
        // Reopening is an explicit operator action and keeps bumping revisions.
        let reopened = update(
            &mut conn,
            UpdateOpenLoopInput {
                id: loop_id.clone(),
                expected_revision: 2,
                content: None,
                time: None,
                state: Some(OpenLoopState::Tracking),
            },
            400,
        )
        .unwrap();
        assert_eq!(reopened.revision, 3);
        assert_eq!(reopened.closed_at, None);
        assert_eq!(reopened.state, OpenLoopState::Tracking);
    }

    #[test]
    fn confirmed_postpone_fixes_new_window_and_returns_to_tracking() {
        let mut conn = connect();
        enqueue(&mut conn, &entry("a", "本周末我要去爬山。"));
        let id = pending_ids(&conn).remove(0);
        let item = review(&mut conn, &id, CandidateStatus::Approved)
            .unwrap()
            .unwrap();
        let loop_id = item.id.clone();
        // The scheduler (later in P1) is what moves a scheduled topic to due.
        conn.execute("UPDATE soul_open_loops SET state='due'", [])
            .unwrap();
        let postponed = update(
            &mut conn,
            UpdateOpenLoopInput {
                id: loop_id.clone(),
                expected_revision: 1,
                content: None,
                time: Some(OpenLoopTime {
                    expression: Some("周末".into()),
                    baseline: 300,
                    timezone: "Asia/Shanghai".into(),
                    starts_at: Some(600),
                    ends_at: Some(700),
                    parser_version: "ignored".into(),
                }),
                state: None,
            },
            300,
        )
        .unwrap();
        assert_eq!(postponed.revision, 2);
        assert_eq!(postponed.state, OpenLoopState::Tracking);
        assert_eq!(postponed.time.starts_at, Some(600));
        assert_eq!(postponed.time.ends_at, Some(700));
        assert_eq!(postponed.time.timezone, "Asia/Shanghai");
        assert!(postponed.closed_at.is_none());
        // Half-specified windows cannot schedule a guess.
        let error = update(
            &mut conn,
            UpdateOpenLoopInput {
                id: loop_id.clone(),
                expected_revision: 2,
                content: None,
                time: Some(OpenLoopTime {
                    expression: Some("周末".into()),
                    baseline: 300,
                    timezone: "Asia/Shanghai".into(),
                    starts_at: Some(800),
                    ends_at: None,
                    parser_version: "ignored".into(),
                }),
                state: None,
            },
            400,
        )
        .unwrap_err();
        assert_eq!(error, "invalid_loop_time");
        // Content-only edits bump revision and keep everything else.
        let renamed = update(
            &mut conn,
            UpdateOpenLoopInput {
                id: loop_id.clone(),
                expected_revision: 2,
                content: Some("我打算整理仓库并贴标签".into()),
                time: None,
                state: None,
            },
            400,
        )
        .unwrap();
        assert_eq!(renamed.revision, 3);
        assert_eq!(renamed.content, "我打算整理仓库并贴标签");
        assert_eq!(renamed.time.starts_at, Some(600));
    }

    #[test]
    fn purge_for_source_revokes_queue_and_removes_topic_rows() {
        let mut conn = Connection::open_in_memory().unwrap();
        store::migrate(&mut conn).unwrap();
        conn.execute(
            "INSERT INTO soul_open_loops(id,revision,content,source_ref,time_baseline,timezone,parser_version,state,created_at,updated_at)
             VALUES('loop-a',1,'plan','{\"kind\":\"chat_entry\",\"id\":\"s1\",\"revision\":1}',100,'Asia/Shanghai','1','tracking',100,100)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO soul_proactive_ledger(id,category,source_ref,dedupe_key,template_id,valid_from,expires_at,state,created_at)
             VALUES('m1','open_loop','{\"kind\":\"open_loop\",\"id\":\"other\",\"revision\":1}','k1','t',100,1000,'pending',100)",
            [],
        )
        .unwrap();
        assert_eq!(purge_for_source(&mut conn, "s1", 300).unwrap(), 1);
        let loop_row: i64 = conn
            .query_row(
                "SELECT count(*) FROM soul_open_loops WHERE id='loop-a'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(loop_row, 0);
        // Messages from other sources stay untouched.
        let alive: i64 = conn
            .query_row(
                "SELECT count(*) FROM soul_proactive_ledger WHERE state='pending'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(alive, 1);
    }
}

#[cfg(test)]
mod calendar_integration_tests {
    use super::*;
    use chrono::TimeZone;
    #[test]
    fn pending_and_approved_windows_match_and_do_not_reparse_later() {
        let mut conn = Connection::open_in_memory().unwrap();
        store::migrate(&mut conn).unwrap();
        let baseline = chrono::Utc
            .with_ymd_and_hms(2026, 10, 30, 12, 0, 0)
            .unwrap()
            .timestamp();
        let entry = crate::chat_session::ChatHistoryEntry {
            id: "calendar-source".into(),
            prompt: "我打算下个月去旅行".into(),
            response: "".into(),
            created_at: baseline as u64,
        };
        store::transaction(&mut conn, |tx| {
            enqueue(tx, &entry, baseline, "America/New_York")
        })
        .unwrap();
        let candidate = pending(&conn).unwrap().candidates.remove(0).candidate;
        let start = chrono::Utc
            .with_ymd_and_hms(2026, 11, 1, 4, 0, 0)
            .unwrap()
            .timestamp();
        let end = chrono::Utc
            .with_ymd_and_hms(2026, 12, 1, 5, 0, 0)
            .unwrap()
            .timestamp()
            - 1;
        assert_eq!(
            (candidate.time.starts_at, candidate.time.ends_at),
            (Some(start), Some(end))
        );
        let item = review(
            &mut conn,
            ReviewOpenLoopInput {
                candidate_id: candidate.id,
                decision: CandidateStatus::Approved,
                content: None,
                time: None,
            },
            baseline + 10,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            (item.time.starts_at, item.time.ends_at),
            (Some(start), Some(end))
        );
        assert_eq!(list(&conn, None).unwrap()[0].time.starts_at, Some(start));
        assert_eq!(item.time.baseline, baseline);
    }
    #[test]
    fn vague_times_stay_unscheduled_and_invalid_zones_are_rejected() {
        let time = OpenLoopTime {
            expression: Some("有空".into()),
            baseline: 100,
            timezone: "Asia/Shanghai".into(),
            starts_at: None,
            ends_at: None,
            parser_version: "unparsed-1".into(),
        };
        assert_eq!(resolve_time(&time).unwrap().starts_at, None);
        assert!(resolve_time(&OpenLoopTime {
            timezone: "not-a-zone".into(),
            ..time
        })
        .is_err());
    }
}
