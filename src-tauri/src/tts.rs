//! 本地 TTS：调用系统语音（macOS say / Windows SAPI / Linux spd-say）朗读文本。

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::State;
use thiserror::Error;

/// 模块内函数的类型化错误。Display 保留原有中文文案，经
/// `From<TtsError> for String` 兼容命令边界既有的 `Result<_, String>` 签名。
#[derive(Debug, Error)]
pub enum TtsError {
    #[error("无法读取本地朗读状态")]
    StateLock,
    #[cfg(target_os = "macos")]
    #[error("无法启动 macOS 本地朗读：{0}")]
    SpawnMacOS(String),
    #[cfg(target_os = "windows")]
    #[error("无法启动 Windows 本地朗读：{0}")]
    SpawnWindows(String),
    #[cfg(target_os = "linux")]
    #[error("无法启动 Linux 本地朗读，请安装 speech-dispatcher：{0}")]
    SpawnLinux(String),
}

impl From<TtsError> for String {
    fn from(error: TtsError) -> Self {
        error.to_string()
    }
}

pub fn stop_local_tts(tts: &LocalTts) -> Result<(), TtsError> {
    let mut active = tts.0.lock().map_err(|_| TtsError::StateLock)?;
    if let Some(mut child) = active.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

fn is_emoji_component(character: char) -> bool {
    matches!(
        character as u32,
        0x1F1E6..=0x1F1FF
            | 0x1F300..=0x1FAFF
            | 0x2300..=0x23FF
            | 0x2600..=0x27BF
            | 0x2B00..=0x2BFF
            | 0xFE0E..=0xFE0F
            | 0x200D
            | 0x20E3
    )
}

pub fn text_for_speech(text: &str) -> String {
    text.chars()
        .filter(|character| !is_emoji_component(*character))
        .collect::<String>()
}

fn spawn_local_tts(text: &str) -> Result<Child, TtsError> {
    #[cfg(target_os = "macos")]
    {
        Command::new("say")
            .arg("--")
            .arg(text)
            .spawn()
            .map_err(|error| TtsError::SpawnMacOS(error.to_string()))
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Add-Type -AssemblyName System.Speech; $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer; $speaker.Speak($env:PIKO_TTS_TEXT)",
            ])
            .env("PIKO_TTS_TEXT", text)
            .spawn()
            .map_err(|error| TtsError::SpawnWindows(error.to_string()))
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("spd-say")
            .arg("--")
            .arg(text)
            .spawn()
            .map_err(|error| TtsError::SpawnLinux(error.to_string()))
    }
}

#[tauri::command]
pub fn speak_local_text(tts: State<'_, LocalTts>, text: String) -> Result<(), String> {
    let text = text_for_speech(&text);
    let text = text.trim();
    if text.is_empty() {
        return Err("没有可朗读的内容".to_string());
    }
    stop_local_tts(&tts)?;
    let child = spawn_local_tts(text)?;
    let active: &LocalTts = &tts;
    *active
        .0
        .lock()
        .map_err(|_| "无法更新本地朗读状态".to_string())? = Some(child);
    Ok(())
}

#[tauri::command]
pub fn stop_local_speech(tts: State<'_, LocalTts>) -> Result<(), String> {
    stop_local_tts(&tts)
}

#[derive(Default)]
pub struct LocalTts(Mutex<Option<Child>>);
