//! Legacy confirmation/rejection facade, shared by interactive chat and Agent execution.
use crate::calendar_service::{calendar_conflict_note, calendar_event_batch_input_from_value, calendar_event_input_from_value, read_calendar_events};
use super::selection::selected_calendar_batch_events;
use super::store::DraftStoreError;
use super::{ActionDrafts, ActionExecution};
use crate::plugins::{PluginRegistry, ToolCall};
use tauri::{AppHandle, State};

fn confirmation_error(error: DraftStoreError) -> String {
    match error {
        DraftStoreError::Unavailable => "无法读取待确认动作".to_string(),
        DraftStoreError::Expired => "该动作草稿已失效".to_string(),
    }
}

#[tauri::command]
pub(crate) fn confirm_chat_action(
    app: AppHandle,
    registry: State<'_, PluginRegistry>,
    drafts: State<'_, ActionDrafts>,
    id: String,
    selected_indexes: Option<Vec<usize>>,
) -> Result<ActionExecution, String> {
    let mut draft = drafts.take(&id).map_err(confirmation_error)?;
    if draft.plugin_id == "piko.calendar"
        && matches!(
            draft.tool_name.as_str(),
            "create_event_batch" | "delete_event_batch"
        )
    {
        draft.arguments["events"] =
            selected_calendar_batch_events(&draft.arguments["events"], selected_indexes)?;
    }
    let calendar_events = if draft.plugin_id == "piko.calendar" {
        read_calendar_events(&app)
    } else {
        Vec::new()
    };
    let conflict_note = if draft.plugin_id == "piko.calendar" && draft.tool_name == "create_event" {
        let input = calendar_event_input_from_value(&draft.arguments)?;
        calendar_conflict_note(&calendar_events, input.start_at, input.end_at)
    } else if draft.plugin_id == "piko.calendar" && draft.tool_name == "create_event_batch" {
        let batch = calendar_event_batch_input_from_value(&draft.arguments)?;
        let conflicts = batch
            .events
            .into_iter()
            .filter_map(|input| {
                calendar_conflict_note(&calendar_events, input.start_at, input.end_at)
            })
            .count();
        if conflicts > 0 {
            Some(format!(
                "提示：其中 {} 条日程与已有安排重叠，但已继续创建。",
                conflicts
            ))
        } else {
            None
        }
    } else {
        None
    };
    let plugin_id = draft.plugin_id.clone();
    let tool_name = draft.tool_name.clone();
    let is_calendar_batch = plugin_id == "piko.calendar" && tool_name == "create_event_batch";
    let result = registry.execute(
        &app,
        ToolCall {
            plugin_id: draft.plugin_id,
            tool_name: draft.tool_name,
            arguments: draft.arguments,
        },
    )?;
    let message = match plugin_id.as_str() {
        "piko.calendar" if is_calendar_batch => "已创建所选日程。",
        "piko.calendar" if matches!(tool_name.as_str(), "delete_event" | "delete_event_batch") => {
            "日程已删除。"
        }
        "piko.calendar" => "日程已创建。",
        "piko.memos" => "备忘录已创建。",
        "piko.reminders" if tool_name == "delete_reminder" => "提醒已删除。",
        _ => "提醒已创建。",
    };
    Ok(ActionExecution {
        message: conflict_note
            .map(|note| format!("{message}\n{note}"))
            .unwrap_or_else(|| message.to_string()),
        follow_up_prompt: format!(
            "系统已经执行用户确认的操作。执行结果如下：\n{}\n请用一句简洁的自然语言向用户确认结果，不要再次调用写入工具。",
            serde_json::to_string(&result).map_err(|error| error.to_string())?
        ),
        result,
    })
}

#[tauri::command]
pub(crate) fn reject_chat_action(
    drafts: State<'_, ActionDrafts>,
    id: String,
) -> Result<(), String> {
    drafts.take(&id).map_err(confirmation_error)?;
    Ok(())
}
