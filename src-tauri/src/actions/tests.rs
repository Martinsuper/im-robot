//! Draft-preview and pending-action contract tests.
use super::drafts::action_draft_from_tool_call;
use super::store::DraftStoreError;
use super::*;
use crate::plugins::ToolCall;
use chrono::{Local, TimeZone};
use serde_json::json;
use std::{
    sync::{Arc, Barrier},
    thread,
};

#[test]
fn creates_confirmation_drafts_for_model_write_tools() {
    let now = Local
        .with_ymd_and_hms(2026, 6, 1, 10, 0, 0)
        .single()
        .unwrap();
    let draft = action_draft_from_tool_call(
        &ToolCall {
            plugin_id: "piko.calendar".to_string(),
            tool_name: "create_event".to_string(),
            arguments: serde_json::json!({
                "title": "项目评审",
                "startAt": "2026-06-01T11:00:00+08:00",
                "endAt": "2026-06-01T12:00:00+08:00",
            }),
        },
        now,
    )
    .unwrap();

    assert_eq!(draft.plugin_id, "piko.calendar");
    assert!(draft.summary.contains("项目评审"));
    assert!(draft.summary.contains("2026-06-01 11:00"));
}

#[test]
fn creates_confirmation_drafts_for_deletions() {
    let now = Local
        .with_ymd_and_hms(2026, 6, 1, 10, 0, 0)
        .single()
        .unwrap();
    let reminder_draft = action_draft_from_tool_call(
        &ToolCall {
            plugin_id: "piko.reminders".to_string(),
            tool_name: "delete_reminder".to_string(),
            arguments: serde_json::json!({
                "id": "reminder-1",
                "title": "提交周报",
                "dueAt": "2026-06-01T18:00:00+08:00",
                "repeat": "none",
            }),
        },
        now,
    )
    .unwrap();
    let calendar_draft = action_draft_from_tool_call(
        &ToolCall {
            plugin_id: "piko.calendar".to_string(),
            tool_name: "delete_event".to_string(),
            arguments: serde_json::json!({
                "id": "event-1",
                "title": "项目评审",
                "startAt": "2026-06-01T11:00:00+08:00",
                "endAt": "2026-06-01T12:00:00+08:00",
            }),
        },
        now,
    )
    .unwrap();

    assert_eq!(reminder_draft.tool_name, "delete_reminder");
    assert!(reminder_draft.summary.contains("提交周报"));
    assert!(reminder_draft.summary.contains("2026-06-01 18:00"));
    assert_eq!(calendar_draft.tool_name, "delete_event");
    assert!(calendar_draft.summary.contains("项目评审"));
    assert!(calendar_draft.summary.contains("2026-06-01 11:00"));
}

#[test]
fn builds_batch_calendar_delete_confirmation_drafts() {
    let draft = action_draft_from_tool_call(
        &ToolCall {
            plugin_id: "piko.calendar".to_string(),
            tool_name: "delete_event_batch".to_string(),
            arguments: serde_json::json!({
                "events": [
                    { "id": "event-1", "title": "日程一" },
                    { "id": "event-2", "title": "日程二" }
                ]
            }),
        },
        Local::now(),
    )
    .unwrap();

    assert!(draft.summary.contains("批量删除 2 条日程"));
    assert!(draft.summary.contains("日程一"));
    assert!(draft.summary.contains("日程二"));
}

fn pending(id: &str) -> ActionDraft {
    ActionDraft {
        id: id.into(),
        plugin_id: "piko.memos".into(),
        tool_name: "create_memo".into(),
        summary: "待确认".into(),
        arguments: json!({"title":"original"}),
        created_at: 1,
    }
}

#[test]
fn draft_inspection_is_detached_and_consumption_is_final() {
    let store = ActionDrafts::default();
    store.insert(pending("draft")).unwrap();
    let mut inspection = store.get("draft").unwrap().unwrap();
    inspection.arguments["title"] = json!("inspection changed");
    assert_eq!(
        store.get("draft").unwrap().unwrap().arguments["title"],
        "original"
    );
    assert_eq!(store.take("draft").unwrap().id, "draft");
    assert_eq!(store.take("draft").unwrap_err(), DraftStoreError::Expired);
    assert!(store.get("draft").unwrap().is_none());
}

#[test]
fn concurrent_confirmations_can_only_consume_one_draft() {
    let store = Arc::new(ActionDrafts::default());
    store.insert(pending("shared")).unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let store = store.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                store.take("shared")
            })
        })
        .collect();
    barrier.wait();
    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(DraftStoreError::Expired)))
            .count(),
        1
    );
}

#[test]
fn task_cleanup_does_not_discard_another_tasks_pending_action() {
    let store = ActionDrafts::default();
    store.insert(pending("task-a")).unwrap();
    store.insert(pending("task-b")).unwrap();
    store
        .discard(vec!["task-a".into(), "already-consumed".into()])
        .unwrap();
    assert!(store.get("task-a").unwrap().is_none());
    assert_eq!(store.take("task-b").unwrap().id, "task-b");
}
