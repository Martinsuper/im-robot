//! Local speech playback, model downloads and voice transcription.
use crate::common::parse_data_url;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
#[cfg(feature = "speech-recognition")]
use futures_util::StreamExt;
use serde::Deserialize;
use serde::Serialize;
use std::fs;
#[cfg(feature = "speech-recognition")]
use std::io::Write;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::sync::Mutex;
#[cfg(feature = "speech-recognition")]
use std::time::Duration;
use tauri::AppHandle;
#[cfg(feature = "speech-recognition")]
use tauri::Emitter;
use tauri::Manager;
use tauri::State;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceTranscriptionInput {
    pub(crate) audio_data_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceTranscriptionOutput {
    pub(crate) text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechModelStatus {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) file_name: String,
    pub(crate) download_url: String,
    pub(crate) downloaded: bool,
    pub(crate) byte_size: u64,
    pub(crate) path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadSpeechModelInput {
    pub(crate) model_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg(feature = "speech-recognition")]
pub(crate) struct SpeechModelDownloadProgress {
    pub(crate) model_id: String,
    pub(crate) downloaded_bytes: u64,
    pub(crate) total_bytes: Option<u64>,
    pub(crate) percent: Option<f32>,
    pub(crate) completed: bool,
}

pub(crate) struct SpeechModelDefinition {
    pub(crate) id: &'static str,
    pub(crate) name: &'static str,
    pub(crate) file_name: &'static str,
    pub(crate) download_url: &'static str,
    pub(crate) archive_dir: &'static str,
}

#[derive(Default)]
pub(crate) struct LocalTts(pub(crate) Mutex<Option<Child>>);

pub(crate) fn speech_model_definitions() -> &'static [SpeechModelDefinition] {
    &[SpeechModelDefinition {
        id: "sense-voice",
        name: "SenseVoice 中文优化",
        file_name: "model.int8.onnx",
        download_url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2",
        archive_dir: "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
    }]
}

#[cfg(feature = "speech-recognition")]
pub(crate) fn speech_model_definition(model_id: &str) -> Option<&'static SpeechModelDefinition> {
    speech_model_definitions()
        .iter()
        .find(|model| model.id == model_id)
}

pub(crate) fn speech_models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join("speech-models"))
        .map_err(|error| format!("无法访问应用数据目录：{error}"))
}

pub(crate) fn speech_model_path(
    app: &AppHandle,
    definition: &SpeechModelDefinition,
) -> Result<PathBuf, String> {
    Ok(speech_models_dir(app)?
        .join(definition.archive_dir)
        .join(definition.file_name))
}

pub(crate) fn sense_voice_tokens_path(
    app: &AppHandle,
    definition: &SpeechModelDefinition,
) -> Result<PathBuf, String> {
    Ok(speech_models_dir(app)?
        .join(definition.archive_dir)
        .join("tokens.txt"))
}

pub(crate) fn speech_model_status(
    app: &AppHandle,
    definition: &SpeechModelDefinition,
) -> SpeechModelStatus {
    let path = speech_model_path(app, definition).ok();
    let byte_size = path
        .as_ref()
        .and_then(|path| fs::metadata(path).ok())
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let downloaded = byte_size > 0
        && sense_voice_tokens_path(app, definition)
            .map(|p| p.exists())
            .unwrap_or(false);
    SpeechModelStatus {
        id: definition.id.to_string(),
        name: definition.name.to_string(),
        file_name: definition.file_name.to_string(),
        download_url: definition.download_url.to_string(),
        downloaded,
        byte_size,
        path: path.map(|path| path.to_string_lossy().to_string()),
    }
}

pub(crate) fn read_le_u16(bytes: &[u8], offset: usize) -> Result<u16, String> {
    let chunk = bytes
        .get(offset..offset + 2)
        .ok_or_else(|| "WAV 数据不完整".to_string())?;
    Ok(u16::from_le_bytes([chunk[0], chunk[1]]))
}

pub(crate) fn read_le_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let chunk = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| "WAV 数据不完整".to_string())?;
    Ok(u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
}

pub(crate) fn decode_wav_pcm16_mono(bytes: &[u8]) -> Result<(u32, Vec<f32>), String> {
    if bytes.len() < 44 || bytes.get(0..4) != Some(b"RIFF") || bytes.get(8..12) != Some(b"WAVE") {
        return Err("录音必须是 WAV 格式。".to_string());
    }

    let mut offset = 12usize;
    let mut channels = 0u16;
    let mut sample_rate = 0u32;
    let mut bits_per_sample = 0u16;
    let mut audio_format = 0u16;
    let mut data_start = 0usize;
    let mut data_len = 0usize;

    while offset + 8 <= bytes.len() {
        let chunk_id = &bytes[offset..offset + 4];
        let chunk_size = read_le_u32(bytes, offset + 4)? as usize;
        let chunk_start = offset + 8;
        let chunk_end = chunk_start.saturating_add(chunk_size);
        if chunk_end > bytes.len() {
            return Err("WAV chunk 数据不完整。".to_string());
        }
        if chunk_id == b"fmt " {
            audio_format = read_le_u16(bytes, chunk_start)?;
            channels = read_le_u16(bytes, chunk_start + 2)?;
            sample_rate = read_le_u32(bytes, chunk_start + 4)?;
            bits_per_sample = read_le_u16(bytes, chunk_start + 14)?;
        } else if chunk_id == b"data" {
            data_start = chunk_start;
            data_len = chunk_size;
        }
        offset = chunk_end + (chunk_size % 2);
    }

    if audio_format != 1 || bits_per_sample != 16 {
        return Err("当前内置 Whisper 只支持 PCM16 WAV 录音。".to_string());
    }
    if channels == 0 || channels > 2 {
        return Err("当前只支持单声道或双声道录音。".to_string());
    }
    if sample_rate == 0 || data_len == 0 {
        return Err("WAV 录音没有有效音频数据。".to_string());
    }

    let frame_count = data_len / (usize::from(channels) * 2);
    let mut samples = Vec::with_capacity(frame_count);
    for frame in 0..frame_count {
        let mut value = 0.0f32;
        for channel in 0..usize::from(channels) {
            let sample_offset = data_start + (frame * usize::from(channels) + channel) * 2;
            let chunk = bytes
                .get(sample_offset..sample_offset + 2)
                .ok_or_else(|| "WAV 采样数据不完整。".to_string())?;
            value += i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / i16::MAX as f32;
        }
        samples.push(value / f32::from(channels));
    }
    Ok((sample_rate, samples))
}

pub(crate) fn resample_to_16khz(sample_rate: u32, samples: &[f32]) -> Vec<f32> {
    const TARGET_SAMPLE_RATE: u32 = 16_000;
    if sample_rate == TARGET_SAMPLE_RATE || samples.is_empty() {
        return samples.to_vec();
    }
    let ratio = sample_rate as f64 / TARGET_SAMPLE_RATE as f64;
    let output_len = (samples.len() as f64 / ratio).ceil() as usize;
    let mut output = Vec::with_capacity(output_len);
    for index in 0..output_len {
        let source = index as f64 * ratio;
        let left = source.floor() as usize;
        let right = (left + 1).min(samples.len().saturating_sub(1));
        let fraction = (source - left as f64) as f32;
        output.push(samples[left] * (1.0 - fraction) + samples[right] * fraction);
    }
    output
}

#[cfg(feature = "speech-recognition")]
pub(crate) fn transcribe_with_sense_voice(
    model_path: PathBuf,
    tokens_path: PathBuf,
    audio: Vec<f32>,
    sample_rate: i32,
) -> Result<String, String> {
    use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig, OfflineSenseVoiceModelConfig};

    let mut config = OfflineRecognizerConfig::default();
    config.model_config.sense_voice = OfflineSenseVoiceModelConfig {
        model: Some(model_path.to_string_lossy().into_owned()),
        language: Some("zh".to_string()),
        use_itn: true,
    };
    config.model_config.tokens = Some(tokens_path.to_string_lossy().into_owned());
    config.model_config.provider = Some("cpu".to_string());
    config.model_config.num_threads = 2;

    let recognizer = OfflineRecognizer::create(&config)
        .ok_or_else(|| "加载 SenseVoice 模型失败：无法创建识别器".to_string())?;
    let stream = recognizer.create_stream();
    stream.accept_waveform(sample_rate, &audio);
    recognizer.decode(&stream);
    let text = stream
        .get_result()
        .map(|result| result.text.trim().to_string())
        .unwrap_or_default();
    Ok(text)
}

pub(crate) fn stop_local_tts(tts: &LocalTts) -> Result<(), String> {
    let mut active = tts
        .0
        .lock()
        .map_err(|_| "无法读取本地朗读状态".to_string())?;
    if let Some(mut child) = active.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

pub(crate) fn is_emoji_component(character: char) -> bool {
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

pub(crate) fn text_for_speech(text: &str) -> String {
    text.chars()
        .filter(|character| !is_emoji_component(*character))
        .collect::<String>()
}

pub(crate) fn spawn_local_tts(text: &str) -> Result<Child, String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("say")
            .arg("--")
            .arg(text)
            .spawn()
            .map_err(|error| format!("无法启动 macOS 本地朗读：{error}"))
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
            .map_err(|error| format!("无法启动 Windows 本地朗读：{error}"))
    }
    #[cfg(target_os = "linux")]
    {
        Command::new("spd-say")
            .arg("--")
            .arg(text)
            .spawn()
            .map_err(|error| format!("无法启动 Linux 本地朗读，请安装 speech-dispatcher：{error}"))
    }
}

#[tauri::command]
pub(crate) fn speak_local_text(tts: State<'_, LocalTts>, text: String) -> Result<(), String> {
    let text = text_for_speech(&text);
    let text = text.trim();
    if text.is_empty() {
        return Err("没有可朗读的内容".to_string());
    }
    stop_local_tts(&tts)?;
    let child = spawn_local_tts(text)?;
    *tts.0
        .lock()
        .map_err(|_| "无法更新本地朗读状态".to_string())? = Some(child);
    Ok(())
}

#[tauri::command]
pub(crate) fn stop_local_speech(tts: State<'_, LocalTts>) -> Result<(), String> {
    stop_local_tts(&tts)
}

#[tauri::command]
pub(crate) fn get_speech_model_status(app: AppHandle) -> Vec<SpeechModelStatus> {
    if !cfg!(feature = "speech-recognition") {
        return Vec::new();
    }
    speech_model_definitions()
        .iter()
        .map(|definition| speech_model_status(&app, definition))
        .collect()
}

#[cfg(feature = "speech-recognition")]
#[tauri::command]
pub(crate) async fn download_speech_model(
    app: AppHandle,
    input: DownloadSpeechModelInput,
) -> Result<SpeechModelStatus, String> {
    let definition =
        speech_model_definition(&input.model_id).ok_or_else(|| "不支持的语音模型".to_string())?;
    let directory = speech_models_dir(&app)?;
    fs::create_dir_all(&directory).map_err(|error| format!("创建模型目录失败：{error}"))?;

    if speech_model_status(&app, definition).downloaded {
        return Ok(speech_model_status(&app, definition));
    }

    let archive_name = format!("{}.tar.bz2", definition.archive_dir);
    let temp_path = directory.join(format!("{archive_name}.download"));
    let final_path = directory.join(&archive_name);

    let response = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(1800))
        .build()
        .map_err(|error| error.to_string())?
        .get(definition.download_url)
        .header(reqwest::header::USER_AGENT, "Piko-Desktop-Companion")
        .send()
        .await
        .map_err(|error| format!("下载语音模型失败：{error}"))?
        .error_for_status()
        .map_err(|error| format!("下载语音模型失败：{error}"))?;
    let total_bytes = response.content_length();
    let mut stream = response.bytes_stream();
    let mut file =
        fs::File::create(&temp_path).map_err(|error| format!("创建模型文件失败：{error}"))?;
    let mut downloaded_bytes = 0u64;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("读取模型下载数据失败：{error}"))?;
        file.write_all(&chunk)
            .map_err(|error| format!("写入模型文件失败：{error}"))?;
        downloaded_bytes += chunk.len() as u64;
        let progress = SpeechModelDownloadProgress {
            model_id: definition.id.to_string(),
            downloaded_bytes,
            total_bytes,
            percent: total_bytes.map(|total| downloaded_bytes as f32 / total as f32),
            completed: false,
        };
        let _ = app.emit_to("panel", "speech-model-download-progress", progress);
    }
    file.flush()
        .map_err(|error| format!("保存模型文件失败：{error}"))?;
    drop(file);

    fs::rename(&temp_path, &final_path).map_err(|error| format!("保存压缩包失败：{error}"))?;
    let decoder = bzip2::read::BzDecoder::new(
        fs::File::open(&final_path).map_err(|error| format!("打开压缩包失败：{error}"))?,
    );
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(&directory)
        .map_err(|error| format!("解压模型失败：{error}"))?;
    fs::remove_file(&final_path).map_err(|error| format!("清理压缩包失败：{error}"))?;

    let progress = SpeechModelDownloadProgress {
        model_id: definition.id.to_string(),
        downloaded_bytes,
        total_bytes,
        percent: Some(1.0),
        completed: true,
    };
    let _ = app.emit_to("panel", "speech-model-download-progress", progress);
    Ok(speech_model_status(&app, definition))
}

#[tauri::command]
pub(crate) async fn transcribe_voice_input(
    app: AppHandle,
    input: VoiceTranscriptionInput,
) -> Result<VoiceTranscriptionOutput, String> {
    let (_, encoded_audio) = parse_data_url(&input.audio_data_url)?;
    let audio_bytes = BASE64_STANDARD
        .decode(encoded_audio)
        .map_err(|error| format!("录音数据解析失败：{error}"))?;
    if audio_bytes.is_empty() {
        return Err("没有录到语音内容。".to_string());
    }
    if audio_bytes.len() > 25 * 1024 * 1024 {
        return Err("录音太长，请缩短后重试。".to_string());
    }

    let definition = speech_model_definitions()
        .first()
        .ok_or_else(|| "未配置语音模型".to_string())?;
    if !speech_model_status(&app, definition).downloaded {
        return Err(format!(
            "请先在设置中下载 {}，再使用语音输入。",
            definition.name
        ));
    }

    let (sample_rate, samples) = decode_wav_pcm16_mono(&audio_bytes)?;
    let audio = resample_to_16khz(sample_rate, &samples);
    let model_path = speech_model_path(&app, definition)?;
    let tokens_path = sense_voice_tokens_path(&app, definition)?;
    let text = crate::background::SUPERVISOR
        .blocking("speech-transcription", move || {
            transcribe_with_sense_voice(model_path, tokens_path, audio, 16_000)
        })
        .await
        .map_err(|error| format!("本地语音转写任务失败：{error}"))?;

    if text.is_empty() {
        return Err("语音模型没有识别到文字。".to_string());
    }
    Ok(VoiceTranscriptionOutput { text })
}

#[cfg(not(feature = "speech-recognition"))]
pub(crate) fn transcribe_with_sense_voice(
    _: PathBuf,
    _: PathBuf,
    _: Vec<f32>,
    _: i32,
) -> Result<String, String> {
    Err("此构建未启用语音识别".into())
}
#[cfg(not(feature = "speech-recognition"))]
#[tauri::command]
pub(crate) async fn download_speech_model(
    app: AppHandle,
    input: DownloadSpeechModelInput,
) -> Result<SpeechModelStatus, String> {
    let _ = (app, input.model_id);
    Err("此构建未启用语音识别".into())
}
