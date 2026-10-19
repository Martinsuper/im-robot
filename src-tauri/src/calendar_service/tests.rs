use super::{
    icalendar::render_icalendar, scheduler::collect_due_calendar_events, service::*, CalendarEvent,
};
use chrono::{Duration as ChronoDuration, Local};
use std::{collections::HashSet, fs, path::PathBuf};

#[test]
fn calendar_event_notices_fire_once_near_start_time() {
    let events = vec![
        CalendarEvent {
            id: "soon".to_string(),
            title: "站会".to_string(),
            start_at: 100,
            end_at: 160,
            location: None,
            notes: None,
        },
        CalendarEvent {
            id: "old".to_string(),
            title: "旧日程".to_string(),
            start_at: 30,
            end_at: 40,
            location: None,
            notes: None,
        },
        CalendarEvent {
            id: "future".to_string(),
            title: "稍后".to_string(),
            start_at: 130,
            end_at: 160,
            location: None,
            notes: None,
        },
    ];
    let mut notified = HashSet::new();

    let due = collect_due_calendar_events(&events, 110, &mut notified);
    let repeated = collect_due_calendar_events(&events, 111, &mut notified);

    assert_eq!(due.len(), 1);
    assert_eq!(due[0].id, "soon");
    assert!(repeated.is_empty());
}
#[test]
fn batch_delete_invalid_targets_never_mutate_events() {
    let original: Vec<super::CalendarEvent> = serde_json::from_value(serde_json::json!([
        {"id":"e1","title":"一","startAt":100,"endAt":200},
        {"id":"e2","title":"二","startAt":300,"endAt":400}
    ]))
    .unwrap();
    for targets in [
        serde_json::json!([]),
        serde_json::json!([{"id":"e1"},{"id":"e1"}]),
        serde_json::json!([{"id":"e1"},{"id":"missing"}]),
    ] {
        let mut events = original.clone();
        let input = super::CalendarDeleteBatchInput {
            events: targets
                .as_array()
                .unwrap()
                .iter()
                .map(super::calendar_delete_input_from_value)
                .collect::<Result<Vec<_>, _>>()
                .unwrap(),
        };
        assert!(super::remove_calendar_event_batch(&mut events, input).is_err());
        assert_eq!(events, original, "验证失败时不得部分删除");
    }
    assert!(crate::actions::selection::selected_calendar_batch_events(
        &serde_json::json!({}),
        None
    )
    .is_err());
    assert!(crate::actions::selection::selected_calendar_batch_events(
        &serde_json::json!([]),
        None
    )
    .is_err());
}
#[test]
fn overlapping_calendar_events_are_created_with_a_hint() {
    let (_directory, path) = temp_calendar_events_path();
    let now = Local::now() + ChronoDuration::days(1);
    let first = calendar_event_input_from_value(&serde_json::json!({
        "title": "已有日程",
        "startAt": (now + ChronoDuration::hours(1)).timestamp() as u64,
        "endAt": (now + ChronoDuration::hours(2)).timestamp() as u64,
    }))
    .unwrap();
    let second = calendar_event_input_from_value(&serde_json::json!({
        "title": "抢购手机",
        "startAt": (now + ChronoDuration::hours(1) + ChronoDuration::minutes(30)).timestamp() as u64,
        "endAt": (now + ChronoDuration::hours(2) + ChronoDuration::minutes(30)).timestamp() as u64,
    }))
    .unwrap();

    let created_first = create_calendar_event_record_at_path(&path, first).unwrap();
    let created_second = create_calendar_event_record_at_path(&path, second).unwrap();
    let queried = read_calendar_events_from_path(&path);

    assert_eq!(queried.len(), 2);
    assert_eq!(created_first.title, "已有日程");
    assert_eq!(created_second.title, "抢购手机");
    assert!(calendar_conflict_note(
        &queried[..1],
        created_second.start_at,
        created_second.end_at
    )
    .is_some());
    let _ = fs::remove_file(path);
}
#[test]
fn calendar_conflicts_exclude_touching_boundaries() {
    let events = vec![CalendarEvent {
        id: "one".to_string(),
        title: "已有日程".to_string(),
        start_at: 100,
        end_at: 200,
        location: None,
        notes: None,
    }];

    assert_eq!(find_calendar_conflicts(&events, 150, 250).len(), 1);
    assert!(find_calendar_conflicts(&events, 200, 300).is_empty());
}
#[test]
fn deletes_a_batch_of_calendar_events_atomically() {
    let (_directory, path) = temp_calendar_events_path();
    let now = Local::now() + ChronoDuration::days(1);
    let first = create_calendar_event_record_at_path(
        &path,
        calendar_event_input_from_value(&serde_json::json!({
            "title": "日程一",
            "startAt": (now + ChronoDuration::hours(1)).timestamp() as u64,
            "endAt": (now + ChronoDuration::hours(2)).timestamp() as u64,
        }))
        .unwrap(),
    )
    .unwrap();
    let second = create_calendar_event_record_at_path(
        &path,
        calendar_event_input_from_value(&serde_json::json!({
            "title": "日程二",
            "startAt": (now + ChronoDuration::hours(3)).timestamp() as u64,
            "endAt": (now + ChronoDuration::hours(4)).timestamp() as u64,
        }))
        .unwrap(),
    )
    .unwrap();

    let deleted = delete_calendar_event_batch_record_at_path(
        &path,
        calendar_delete_batch_input_from_value(&serde_json::json!({
            "events": [{ "id": first.id }, { "id": second.id }]
        }))
        .unwrap(),
    )
    .unwrap();

    assert_eq!(deleted.len(), 2);
    assert!(read_calendar_events_from_path(&path).is_empty());
    let _ = fs::remove_file(path);
}
#[test]
fn keeps_calendar_events_when_a_batch_delete_target_is_missing() {
    let (_directory, path) = temp_calendar_events_path();
    let now = Local::now() + ChronoDuration::days(1);
    let existing = create_calendar_event_record_at_path(
        &path,
        calendar_event_input_from_value(&serde_json::json!({
            "title": "仍需保留",
            "startAt": (now + ChronoDuration::hours(1)).timestamp() as u64,
            "endAt": (now + ChronoDuration::hours(2)).timestamp() as u64,
        }))
        .unwrap(),
    )
    .unwrap();

    let result = delete_calendar_event_batch_record_at_path(
        &path,
        calendar_delete_batch_input_from_value(&serde_json::json!({
            "events": [{ "id": existing.id }, { "id": "missing-event" }]
        }))
        .unwrap(),
    );

    assert!(result.is_err());
    assert_eq!(read_calendar_events_from_path(&path).len(), 1);
    let _ = fs::remove_file(path);
}
#[test]
fn normalizes_iso_calendar_tool_timestamps() {
    let input = calendar_event_input_from_value(&serde_json::json!({
        "title": "项目评审",
        "startAt": "2026-06-02T15:00:00+08:00",
        "endAt": "2026-06-02T16:00:00+08:00",
    }))
    .unwrap();

    assert_eq!(
        input.start_at,
        chrono::DateTime::parse_from_rfc3339("2026-06-02T15:00:00+08:00")
            .unwrap()
            .timestamp() as u64
    );
    assert_eq!(
        input.end_at,
        chrono::DateTime::parse_from_rfc3339("2026-06-02T16:00:00+08:00")
            .unwrap()
            .timestamp() as u64
    );
}
#[test]
fn renders_icalendar_with_escaped_text() {
    let calendar = render_icalendar(&[CalendarEvent {
        id: "one".to_string(),
        title: "评审,同步".to_string(),
        start_at: 1_780_384_400,
        end_at: 1_780_388_000,
        location: Some("会议室;A".to_string()),
        notes: None,
    }])
    .unwrap();
    assert!(calendar.contains("BEGIN:VCALENDAR\r\n"));
    assert!(calendar.contains("SUMMARY:评审\\,同步"));
    assert!(calendar.contains("LOCATION:会议室\\;A"));
}

fn temp_calendar_events_path() -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("calendar-events.json");
    (directory, path)
}
