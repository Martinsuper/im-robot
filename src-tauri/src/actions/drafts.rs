//! Business-action previews; creating a draft never executes its tool.
use crate::calendar_service::{calendar_delete_batch_input_from_value, calendar_delete_input_from_value, calendar_event_batch_input_from_value, calendar_event_input_from_value};
use crate::reminder_service::{reminder_delete_input_from_value, reminder_input_from_value, repeat_rule_label};
use crate::memos::{infer_memo_category, memo_category_label, memo_input_from_value, summarize_memo};
use super::ActionDraft;
use crate::plugins::ToolCall;
use crate::memory;
use chrono::{DateTime, Local, TimeZone};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn action_draft_id() -> String {
    format!(
        "action-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

pub(crate) fn format_tool_timestamp(value: Option<u64>) -> Option<String> {
    value.and_then(|timestamp| {
        Local
            .timestamp_opt(timestamp as i64, 0)
            .single()
            .map(|date_time| date_time.format("%Y-%m-%d %H:%M").to_string())
    })
}

#[cfg(test)]
pub(crate) fn action_draft_from_tool_call(
    call: &ToolCall,
    now: DateTime<Local>,
) -> Result<ActionDraft, String> {
    action_draft_from_tool_call_with_locale(call, now, "zh-CN")
}

pub(crate) fn action_draft_from_tool_call_with_locale(
    call: &ToolCall,
    now: DateTime<Local>,
    locale: &str,
) -> Result<ActionDraft, String> {
    let mut summary = match (call.plugin_id.as_str(), call.tool_name.as_str()) {
        ("piko.reminders", "create_reminder") => {
            let input = reminder_input_from_value(&call.arguments)?;
            let formatted_due_at = Local
                .timestamp_opt(input.due_at as i64, 0)
                .single()
                .ok_or_else(|| "提醒时间无效".to_string())?
                .format("%Y-%m-%d %H:%M")
                .to_string();
            format!(
                "创建提醒「{}」\n时间：{formatted_due_at}\n重复：{}",
                input.title,
                repeat_rule_label(&input.repeat)
            )
        }
        ("piko.reminders", "delete_reminder") => {
            let input = reminder_delete_input_from_value(&call.arguments)?;
            let title = input.title.unwrap_or_else(|| format!("ID {}", input.id));
            let due_at = format_tool_timestamp(input.due_at)
                .map(|value| format!("\n时间：{value}"))
                .unwrap_or_default();
            let repeat = input
                .repeat
                .as_deref()
                .map(repeat_rule_label)
                .map(|label| format!("\n重复：{label}"))
                .unwrap_or_default();
            format!("删除提醒「{title}」{due_at}{repeat}")
        }
        ("piko.memos", "create_memo") => {
            let input = memo_input_from_value(&call.arguments)?;
            let preview = summarize_memo(&input.title, &input.content);
            let category = infer_memo_category(&input.title, &input.content);
            format!(
                "创建备忘录「{}」\n分类：{}\n摘要：{}",
                input.title,
                memo_category_label(&category),
                preview
            )
        }
        ("piko.calendar", "create_event") => {
            let input = calendar_event_input_from_value(&call.arguments)?;
            let formatted_start = Local
                .timestamp_opt(input.start_at as i64, 0)
                .single()
                .ok_or_else(|| "日程开始时间无效".to_string())?
                .format("%Y-%m-%d %H:%M")
                .to_string();
            let formatted_end = Local
                .timestamp_opt(input.end_at as i64, 0)
                .single()
                .ok_or_else(|| "日程结束时间无效".to_string())?
                .format("%Y-%m-%d %H:%M")
                .to_string();
            format!(
                "创建日程「{}」\n时间：{formatted_start} - {formatted_end}",
                input.title
            )
        }
        ("piko.calendar", "delete_event") => {
            let input = calendar_delete_input_from_value(&call.arguments)?;
            let title = input.title.unwrap_or_else(|| format!("ID {}", input.id));
            let range = match (
                format_tool_timestamp(input.start_at),
                format_tool_timestamp(input.end_at),
            ) {
                (Some(start), Some(end)) => format!("\n时间：{start} - {end}"),
                _ => String::new(),
            };
            format!("删除日程「{title}」{range}")
        }
        ("piko.calendar", "delete_event_batch") => {
            let batch = calendar_delete_batch_input_from_value(&call.arguments)?;
            let mut lines = vec![format!("批量删除 {} 条日程：", batch.events.len())];
            for input in batch.events {
                let title = input.title.unwrap_or_else(|| format!("ID {}", input.id));
                let range = match (
                    format_tool_timestamp(input.start_at),
                    format_tool_timestamp(input.end_at),
                ) {
                    (Some(start), Some(end)) => format!("，{start} - {end}"),
                    _ => String::new(),
                };
                lines.push(format!("• {title}{range}"));
            }
            lines.join("\n")
        }
        ("piko.calendar", "create_event_batch") => {
            let batch = calendar_event_batch_input_from_value(&call.arguments)?;
            let mut lines = vec![format!("批量创建 {} 条日程：", batch.events.len())];
            for input in batch.events {
                let formatted_start = Local
                    .timestamp_opt(input.start_at as i64, 0)
                    .single()
                    .ok_or_else(|| "日程开始时间无效".to_string())?
                    .format("%Y-%m-%d %H:%M")
                    .to_string();
                let formatted_end = Local
                    .timestamp_opt(input.end_at as i64, 0)
                    .single()
                    .ok_or_else(|| "日程结束时间无效".to_string())?
                    .format("%H:%M")
                    .to_string();
                lines.push(format!(
                    "• {}：{formatted_start} - {formatted_end}",
                    input.title
                ));
            }
            lines.join("\n")
        }
        _ => return Err("该工具暂不支持确认后执行".to_string()),
    };
    if call.plugin_id == "piko.calendar" {
        let events = match call.tool_name.as_str() {
            "create_event" => {
                let input = calendar_event_input_from_value(&call.arguments)?;
                vec![(input.start_at, input.end_at)]
            }
            "create_event_batch" => calendar_event_batch_input_from_value(&call.arguments)?
                .events
                .iter()
                .map(|input| (input.start_at, input.end_at))
                .collect(),
            _ => Vec::new(),
        };
        if let Some(advice) = memory::soul::observations::schedule_advice(&events, locale) {
            summary.push_str("\n");
            summary.push_str(advice);
        }
    }
    Ok(ActionDraft {
        id: action_draft_id(),
        plugin_id: call.plugin_id.clone(),
        tool_name: call.tool_name.clone(),
        summary,
        arguments: call.arguments.clone(),
        created_at: now.timestamp().max(0) as u64,
    })
}
