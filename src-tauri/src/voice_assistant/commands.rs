//! 语音助手 IPC 命令：状态查询与手动试听。
use serde::Serialize;
use tauri::AppHandle;

/// 给设置页与气泡窗口的状态快照；晚订阅对账走这里。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceAssistantStatus {
    pub(crate) enabled: bool,
    pub(crate) wake_word: String,
    /// 唤醒模型是否已下载。
    pub(crate) model_ready: bool,
    pub(crate) stage: &'static str,
    pub(crate) transcript: String,
    pub(crate) reply: String,
    pub(crate) message: String,
    pub(crate) error: Option<String>,
}

#[tauri::command]
pub(crate) fn get_voice_assistant_status(app: AppHandle) -> VoiceAssistantStatus {
    let settings = crate::settings::read_settings(&app);
    let model_ready = cfg!(feature = "speech-recognition")
        && crate::speech::speech_model_status(&app, crate::speech::kws_model_definition())
            .downloaded;
    super::status_snapshot(&settings, model_ready)
}

/// 手动触发一次聆听（设置页试听按钮）；不依赖唤醒模型。
#[tauri::command]
pub(crate) fn voice_assistant_trigger_listen() -> Result<(), String> {
    super::STATE.request_manual_trigger();
    Ok(())
}
