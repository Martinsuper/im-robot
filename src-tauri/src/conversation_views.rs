//! UI state handoff between the main chat and a detached native window.
use crate::{attachments::AttachmentPreview, screen_capture::ScreenshotPreview};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ConversationView {
    pub revision: u64,
    pub prompt: String,
    pub cwd: String,
    pub knowledge_scope: Option<String>,
    pub attachment_action: String,
    pub attachment: Option<AttachmentPreview>,
    pub screenshot: Option<ScreenshotPreview>,
}

#[derive(Default)]
pub(crate) struct ConversationViews(Mutex<HashMap<String, ConversationView>>);

pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}
fn path(app: &AppHandle, id: &str) -> Result<std::path::PathBuf, String> {
    if !valid_id(id) {
        return Err("无效的会话标识".into());
    }
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("agent/views")
        .join(format!("{id}.json")))
}
fn validate(view: &ConversationView) -> Result<(), String> {
    if view.prompt.len() > 400_000
        || view.cwd.len() > 16_384
        || view.knowledge_scope.as_ref().is_some_and(|s| s.len() > 480)
    {
        return Err("会话草稿过长".into());
    }
    if view
        .screenshot
        .as_ref()
        .is_some_and(|s| s.data_url.len() > 32 * 1024 * 1024)
    {
        return Err("截图过大".into());
    }
    if view
        .attachment
        .as_ref()
        .is_some_and(|a| a.preview.len() > 4096 || a.display_name.len() > 4096)
    {
        return Err("附件预览过大".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn conversation_get_view(
    app: AppHandle,
    views: State<'_, ConversationViews>,
    conversation_id: String,
) -> Result<ConversationView, String> {
    let _lease = crate::data_gate::try_read()?;
    let file = path(&app, &conversation_id)?;
    let states = views.0.lock().map_err(|_| "无法读取会话草稿")?;
    read_view(&file, &states, &conversation_id)
}

fn read_view(
    file: &std::path::Path,
    states: &HashMap<String, ConversationView>,
    conversation_id: &str,
) -> Result<ConversationView, String> {
    if let Some(view) = states.get(conversation_id) {
        return Ok(view.clone());
    }
    let view: ConversationView = crate::storage::read(file)?;
    validate(&view)?;
    // Reading a device's defaults is not opening a window. Cache only on save,
    // otherwise every completed device session consumes an open-view slot.
    Ok(view)
}

#[tauri::command]
pub(crate) fn conversation_save_view(
    app: AppHandle,
    views: State<'_, ConversationViews>,
    conversation_id: String,
    mut view: ConversationView,
) -> Result<ConversationView, String> {
    let _lease = crate::data_gate::try_read()?;
    let file = path(&app, &conversation_id)?;
    validate(&view)?;
    let mut states = views.0.lock().map_err(|_| "无法保存会话草稿")?;
    if !states.contains_key(&conversation_id) && states.len() >= 32 {
        return Err("打开的会话过多，请关闭不用的窗口".into());
    }
    view.revision = states
        .get(&conversation_id)
        .map_or(1, |previous| previous.revision.saturating_add(1));
    // Text survives an application restart. Capture data and attachment handles are
    // deliberately in-memory: a restart must not resurrect unavailable inputs.
    let persisted = ConversationView {
        attachment: None,
        screenshot: None,
        ..view.clone()
    };
    crate::storage::write(&file, &persisted)?;
    states.insert(conversation_id.clone(), view.clone());
    let _ = app.emit(
        "conversation-view-updated",
        serde_json::json!({"conversationId":conversation_id,"revision":view.revision}),
    );
    Ok(view)
}

#[tauri::command]
pub(crate) fn conversation_chat_history(
    app: AppHandle,
    conversation_id: String,
) -> Result<Vec<crate::chat_session::ChatHistoryEntry>, String> {
    let _lease = crate::data_gate::try_read()?;
    if !valid_id(&conversation_id) {
        return Err("无效的会话标识".into());
    }
    Ok(
        crate::chat_session::repository::try_read_chat_history(&app)?
            .into_iter()
            .filter(|entry| entry.conversation_id.as_deref() == Some(&conversation_id))
            .collect(),
    )
}

#[tauri::command]
pub(crate) fn conversation_forget_view(
    app: AppHandle,
    views: State<'_, ConversationViews>,
    conversation_id: String,
) -> Result<(), String> {
    let _lease = crate::data_gate::try_read()?;
    let file = path(&app, &conversation_id)?;
    if crate::conversation_windows::is_open(&app, &conversation_id)
        || app
            .state::<crate::agent::AgentRuntime>()
            .conversation_busy(&conversation_id)
    {
        return Err("会话仍在使用，不能清除草稿".into());
    }
    views
        .0
        .lock()
        .map_err(|_| "无法清除会话草稿")?
        .remove(&conversation_id);
    match std::fs::remove_file(file) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reading_device_defaults_does_not_consume_open_view_slots() {
        let directory = tempfile::tempdir().unwrap();
        let states: HashMap<_, _> = (0..32)
            .map(|id| (format!("open-{id}"), ConversationView::default()))
            .collect();
        for id in 0..40 {
            assert!(read_view(
                &directory.path().join(format!("device-{id}.json")),
                &states,
                &format!("device-{id}")
            )
            .is_ok());
        }
        assert_eq!(states.len(), 32);
    }
    #[test]
    fn rejects_paths_and_oversized_drafts() {
        for id in ["", "../outside", "a/b", "a\\b"] {
            assert!(!valid_id(id));
        }
        assert!(valid_id("conversation-123"));
        assert!(validate(&ConversationView {
            prompt: "x".repeat(400_001),
            ..Default::default()
        })
        .is_err());
    }
    #[test]
    fn persisted_inputs_do_not_resurrect_after_a_process_restart() {
        let view = ConversationView {
            prompt: "草稿".into(),
            cwd: "/test".into(),
            attachment: Some(AttachmentPreview {
                display_name: "test.txt".into(),
                byte_size: 1,
                char_count: 1,
                preview: "x".into(),
            }),
            ..Default::default()
        };
        let persisted = ConversationView {
            attachment: None,
            screenshot: None,
            ..view
        };
        let restored: ConversationView =
            serde_json::from_value(serde_json::to_value(persisted).unwrap()).unwrap();
        assert_eq!(restored.prompt, "草稿");
        assert!(restored.attachment.is_none());
        assert!(restored.screenshot.is_none());
    }
}
