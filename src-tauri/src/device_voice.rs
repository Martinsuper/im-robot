//! Bounded Passport PCM -> local ASR -> configured companion model -> local PCM synthesis.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::json;
use std::{
    io::{Read, Seek, SeekFrom, Write},
    sync::mpsc::Sender,
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

pub(crate) const SAMPLE_RATE: usize = 16_000;
const TRANSCRIBE_CHUNK_BYTES: usize = SAMPLE_RATE * 2 * 30;
const TRANSCRIBE_OVERLAP_BYTES: usize = SAMPLE_RATE;
pub(crate) const AUDIO_CHUNK: usize = 2048;
const MAX_REPLY_BYTES: usize = SAMPLE_RATE * 2 * 40;
static VOICE_GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

// Spool uploads to a private temporary file. Device and desktop RAM stay
// bounded independently of how long the user holds the recording button.
pub(crate) struct Recording {
    file: tempfile::NamedTempFile,
    bytes: u64,
    offset: u64,
}
impl Recording {
    fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, String> {
        if self.offset == self.bytes {
            return Ok(None);
        }
        let len = (self.bytes - self.offset).min(TRANSCRIBE_CHUNK_BYTES as u64) as usize;
        let mut pcm = vec![0; len];
        self.file
            .as_file_mut()
            .seek(SeekFrom::Start(self.offset))
            .map_err(|e| format!("读取录音失败：{e}"))?;
        self.file
            .as_file_mut()
            .read_exact(&mut pcm)
            .map_err(|e| format!("读取录音失败：{e}"))?;
        self.offset += len as u64;
        if self.offset < self.bytes {
            self.offset -= TRANSCRIBE_OVERLAP_BYTES as u64;
        }
        Ok(Some(pcm))
    }
}
pub(crate) struct Upload {
    pub id: String,
    recording: Recording,
    last_received: std::time::Instant,
}
impl Upload {
    pub fn new(id: String) -> Result<Self, String> {
        let file =
            tempfile::NamedTempFile::new().map_err(|e| format!("创建录音临时文件失败：{e}"))?;
        Ok(Self {
            id,
            recording: Recording {
                file,
                bytes: 0,
                offset: 0,
            },
            last_received: std::time::Instant::now(),
        })
    }
    pub fn push(&mut self, data: &[u8]) -> Result<(), String> {
        if data.is_empty() || !data.len().is_multiple_of(2) || data.len() > AUDIO_CHUNK {
            return Err("录音数据格式错误".into());
        }
        if self.last_received.elapsed() > Duration::from_secs(15) {
            return Err("录音上传中断，请重试".into());
        }
        self.recording
            .file
            .as_file_mut()
            .write_all(data)
            .map_err(|e| format!("保存录音失败，请检查磁盘空间：{e}"))?;
        self.recording.bytes += data.len() as u64;
        self.last_received = std::time::Instant::now();
        Ok(())
    }
    pub fn finish(self) -> Result<(String, Recording), String> {
        if self.recording.bytes < (SAMPLE_RATE / 5 * 2) as u64 {
            return Err("录音太短，请按住说话后再松开".into());
        }
        Ok((self.id, self.recording))
    }
}

fn append_transcript(text: &mut String, next: &str) {
    let next = next.trim();
    if next.is_empty() {
        return;
    }
    if text.is_empty() {
        text.push_str(next);
        return;
    }
    let old: Vec<char> = text
        .chars()
        .filter(|c| c.is_alphanumeric())
        .rev()
        .take(80)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let new: Vec<_> = next
        .char_indices()
        .filter(|(_, c)| c.is_alphanumeric())
        .take(80)
        .collect();
    let overlap = (3..=old.len().min(new.len()))
        .rev()
        .find(|&n| {
            old[old.len() - n..]
                .iter()
                .copied()
                .eq(new[..n].iter().map(|(_, c)| *c))
        })
        .unwrap_or(0);
    let mut tail = if overlap == 0 {
        next
    } else {
        let (offset, cp) = new[overlap - 1];
        &next[offset + cp.len_utf8()..]
    };
    if overlap > 0 && text.ends_with(['。', '！', '？', '，', '.', ',', '!', '?']) {
        tail = tail.trim_start_matches(['。', '！', '？', '，', '.', ',', '!', '?', ' ']);
    }
    if overlap == 0
        && text
            .chars()
            .last()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && tail.starts_with(|c: char| c.is_ascii_alphanumeric())
    {
        text.push(' ');
    }
    text.push_str(tail);
}

fn valid_session(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

pub(crate) enum Update {
    Stream {
        text: String,
        rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
        result: tokio::sync::oneshot::Receiver<Result<(), String>>,
    },
    Stage(&'static str),
    Transcript(String),
    Response(String),
    Reply {
        text: String,
        pcm: Vec<u8>,
        warning: Option<String>,
    },
    Confirmation(crate::device_agent::Confirmation),
    ConfirmationResolved(String),
    Notice(String),
    Error(String),
}
pub(crate) fn pcm_wav(pcm: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(pcm.len() + 44);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&(SAMPLE_RATE as u32).to_le_bytes());
    out.extend_from_slice(&(SAMPLE_RATE as u32 * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    out.extend_from_slice(pcm);
    out
}
/// Identity and negotiated capabilities for one device voice turn.
struct VoiceTurn {
    device: String,
    session: Option<String>,
    id: String,
    device_confirmation: bool,
    streaming: bool,
}

fn spawn(
    app: AppHandle,
    input: VoiceTurn,
    recording: Recording,
    tx: Sender<Update>,
    cancel: CancellationToken,
    decisions: tokio::sync::mpsc::Receiver<crate::device_agent::Decision>,
) {
    tauri::async_runtime::spawn(async move {
        let Ok(_permit) = VOICE_GATE.try_acquire() else {
            let _ = tx.send(Update::Error("语音正在处理中，请稍后重试".into()));
            return;
        };
        let result = tokio::time::timeout(
            Duration::from_secs(300 + recording.bytes / (SAMPLE_RATE as u64 * 2)),
            turn(app, input, recording, &tx, &cancel, decisions),
        )
        .await;
        if cancel.is_cancelled() {
            return;
        }
        match result {
            Ok(Ok(())) => (),
            Ok(Err(e)) => {
                let _ = tx.send(Update::Error(e));
            }
            Err(_) => {
                let _ = tx.send(Update::Error(
                    "语音任务超时，可能已有部分操作完成，请在电脑查看任务记录".into(),
                ));
            }
        }
    });
}
async fn turn(
    app: AppHandle,
    input: VoiceTurn,
    mut recording: Recording,
    tx: &Sender<Update>,
    cancel: &CancellationToken,
    decisions: tokio::sync::mpsc::Receiver<crate::device_agent::Decision>,
) -> Result<(), String> {
    let VoiceTurn {
        device,
        session,
        id,
        device_confirmation,
        streaming,
    } = input;
    let turn_at = std::time::Instant::now();
    let _ = tx.send(Update::Stage("transcribing"));
    let mut transcript = String::new();
    while let Some(pcm) = recording.next_chunk()? {
        if cancel.is_cancelled() {
            return Ok(());
        }
        let result = crate::speech::transcribe_voice_input(
            app.clone(),
            crate::speech::VoiceTranscriptionInput {
                audio_data_url: format!("data:audio/wav;base64,{}", STANDARD.encode(pcm_wav(&pcm))),
            },
        )
        .await;
        match result {
            Ok(part) => append_transcript(&mut transcript, &part.text),
            Err(e) if e == "没有识别到清晰语音，请重试。" => {}
            Err(e) => return Err(e),
        }
    }
    drop(recording);
    if cancel.is_cancelled() {
        return Ok(());
    }
    if transcript.is_empty() {
        return Err("没有识别到清晰语音，请重试。".into());
    }
    let _ = tx.send(Update::Transcript(transcript.chars().take(400).collect()));
    eprintln!("[passport-voice] asr_ms={}", turn_at.elapsed().as_millis());
    let thinking_at = std::time::Instant::now();
    let _ = tx.send(Update::Stage("thinking"));
    let response = crate::device_agent::run(
        app.clone(),
        crate::device_agent::DeviceTurn {
            device: &device,
            session: session.as_deref(),
            turn: &id,
            prompt: transcript,
        },
        tx,
        cancel,
        decisions,
        device_confirmation,
    )
    .await?;
    if cancel.is_cancelled() {
        return Ok(());
    }
    eprintln!(
        "[passport-voice] agent_ms={}",
        thinking_at.elapsed().as_millis()
    );
    let text: String = crate::speech::text_for_speech(&response)
        .chars()
        .take(240)
        .collect();
    let _ = app.emit(
        "passport-voice-reply",
        json!({"deviceId":device,"text":text}),
    );
    let _ = tx.send(Update::Response(text.clone()));
    let synthesis_at = std::time::Instant::now();
    let _ = tx.send(Update::Stage("synthesizing"));
    if streaming && crate::tts::settings(&app)?.provider == "mimo" {
        let (audio_tx, rx) = tokio::sync::mpsc::channel(4);
        let (result_tx, result) = tokio::sync::oneshot::channel();
        let speech_text = text.clone();
        tx.send(Update::Stream { text, rx, result })
            .map_err(|_| "设备已断开")?;
        let generated = tokio::select! {
            _=cancel.cancelled()=>Err("语音播放已取消".into()),
            result=crate::tts_stream::synthesize(&app,&speech_text,audio_tx)=>result,
        };
        let _ = result_tx.send(generated);
        return Ok(());
    }
    let audio = tokio::select! { _ = cancel.cancelled() => return Ok(()), audio = crate::tts::synthesize_pcm(&app, &text) => audio };
    eprintln!(
        "[passport-voice] tts_ms={} total_ms={}",
        synthesis_at.elapsed().as_millis(),
        turn_at.elapsed().as_millis()
    );
    let (pcm, warning) = match audio {
        Ok(pcm) => (pcm, None),
        Err(e) => (Vec::new(), Some(e)),
    };
    let _ = tx.send(Update::Reply { text, pcm, warning });
    Ok(())
}
pub(crate) async fn synthesize(text: &str) -> Result<Vec<u8>, String> {
    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let input = dir.path().join("input.txt");
    let output = dir.path().join("reply.wav");
    tokio::fs::write(&input, crate::speech::text_for_speech(text))
        .await
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = tokio::process::Command::new("say");
        if text.chars().any(|c| ('\u{3400}'..='\u{9fff}').contains(&c)) {
            c.args(["-v", "Tingting"]);
        }
        c.args(["--file-format=WAVE", "--data-format=LEI16@16000", "-o"])
            .arg(&output)
            .arg("-f")
            .arg(&input);
        c
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = tokio::process::Command::new("powershell");
        c.args(["-NoProfile","-NonInteractive","-Command", "Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile($env:PIKO_VOICE_OUTPUT); $s.Speak([IO.File]::ReadAllText($env:PIKO_VOICE_INPUT)); $s.Dispose()"])
            .env("PIKO_VOICE_INPUT",&input).env("PIKO_VOICE_OUTPUT",&output);
        c
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = {
        let mut c = tokio::process::Command::new("espeak-ng");
        c.args(["-v", "cmn", "-w"])
            .arg(&output)
            .arg("-f")
            .arg(&input);
        c
    };
    let child = command
        .kill_on_drop(true)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法生成设备语音：{e}"))?;
    let result = tokio::time::timeout(Duration::from_secs(25), child.wait_with_output())
        .await
        .map_err(|_| "本地语音合成超时")?
        .map_err(|e| e.to_string())?;
    if !result.status.success() {
        return Err("本地语音合成失败，请检查系统语音；Linux 需要安装 espeak-ng 中文语音".into());
    }
    let wav = tokio::fs::read(&output).await.map_err(|e| e.to_string())?;
    decode_reply(&wav)
}
fn decode_reply(wav: &[u8]) -> Result<Vec<u8>, String> {
    let (rate, samples) = crate::speech::decode_wav_pcm16_mono(wav)?;
    let samples = crate::speech::resample_to_16khz(rate, &samples);
    if samples.is_empty() {
        return Err("语音合成未生成音频".into());
    }
    if samples.len() * 2 > MAX_REPLY_BYTES {
        return Err("回复语音超过40秒，请缩短问题".into());
    }
    Ok(samples
        .into_iter()
        .flat_map(|s| ((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16).to_le_bytes())
        .collect())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn long_upload_idle_timeout_and_temporary_file_cleanup() {
        let mut upload = Upload::new("abandoned".into()).unwrap();
        let path = upload.recording.file.path().to_owned();
        upload.last_received = std::time::Instant::now() - Duration::from_secs(16);
        assert!(upload.push(&[0, 0]).is_err());
        drop(upload);
        assert!(!path.exists());
    }
    #[test]
    fn overlapping_transcripts_preserve_long_input_and_chinese_boundaries() {
        let mut text = "今天准备整理文件。".to_string();
        append_transcript(&mut text, "整理文件，然后开会。");
        assert_eq!(text, "今天准备整理文件。然后开会。");
        let mut long = "长".repeat(700);
        append_transcript(&mut long, "接着完成后续任务。");
        assert!(long.chars().count() > 700);
        let mut english = "please bring the document".to_string();
        append_transcript(&mut english, "the document to the meeting");
        assert_eq!(english, "please bring the document to the meeting");
    }

    #[test]
    fn pcm_roundtrip_and_disk_backed_long_upload() {
        let pcm: Vec<u8> = (0..3200).flat_map(|n| (n as i16).to_le_bytes()).collect();
        let (rate, samples) = crate::speech::decode_wav_pcm16_mono(&pcm_wav(&pcm)).unwrap();
        assert_eq!(rate, 16000);
        assert_eq!(samples.len(), 3200);
        let mut upload = Upload::new("turn-1".into()).unwrap();
        assert!(upload.push(&[0]).is_err());
        assert!(upload.push(&vec![0; 4096]).is_err());
        for _ in 0..(SAMPLE_RATE * 2 * 65 / AUDIO_CHUNK) {
            upload.push(&vec![0; AUDIO_CHUNK]).unwrap();
        }
        let path = upload.recording.file.path().to_owned();
        let (_, mut recording) = upload.finish().unwrap();
        assert!(recording.bytes > (SAMPLE_RATE * 2 * 60) as u64);
        let mut chunks = 0;
        while let Some(pcm) = recording.next_chunk().unwrap() {
            assert!(pcm.len() <= TRANSCRIBE_CHUNK_BYTES);
            chunks += 1;
        }
        assert_eq!(chunks, 3);
        drop(recording);
        assert!(!path.exists());
        assert!(Upload::new("empty".into()).unwrap().finish().is_err());
    }
    #[test]
    fn resamples_playback_and_rejects_long_audio() {
        let pcm = vec![0; SAMPLE_RATE * 2];
        let out = decode_reply(&pcm_wav(&pcm)).unwrap();
        assert_eq!(out.len(), pcm.len());
        let mut wave = pcm_wav(&pcm);
        wave[24..28].copy_from_slice(&22050u32.to_le_bytes());
        wave[28..32].copy_from_slice(&44100u32.to_le_bytes());
        assert_eq!(
            decode_reply(&wave).unwrap().len(),
            (16000f64 * 16000.0 / 22050.0).ceil() as usize * 2
        );
        assert!(decode_reply(&pcm_wav(&vec![0; MAX_REPLY_BYTES + 32000])).is_err());
    }
    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "requires installed macOS Tingting voice"]
    async fn renders_local_chinese_without_playing_on_computer() {
        assert!(!synthesize("你好，我是 Piko。").await.unwrap().is_empty());
    }
}

use serde_json::Value;
use std::{
    collections::VecDeque,
    net::TcpStream,
    sync::mpsc::{self, Receiver},
    time::Instant,
};
use tungstenite::{Message, WebSocket};
struct Playback {
    pcm: Vec<u8>,
    offset: usize,
    credits: usize,
    ended: bool,
    stream: Option<tokio::sync::mpsc::Receiver<Vec<u8>>>,
    result: Option<tokio::sync::oneshot::Receiver<Result<(), String>>>,
    source_done: bool,
    announced: bool,
    total: usize,
}
#[derive(Default)]
pub(crate) struct Channel {
    id: Option<String>,
    session: Option<String>,
    upload: Option<Upload>,
    rx: Option<Receiver<Update>>,
    cancel: Option<CancellationToken>,
    playback: Option<Playback>,
    started: Option<Instant>,
    recording_seconds: u64,
    seen: VecDeque<String>,
    decisions: Option<tokio::sync::mpsc::Sender<crate::device_agent::Decision>>,
    confirmation: Option<crate::device_agent::Confirmation>,
    device_confirmation: bool,
    streaming: bool,
    response_sent: bool,
}
fn wire(ws: &mut WebSocket<TcpStream>, mut msg: Value) -> Result<(), String> {
    msg["v"] = json!(1);
    ws.send(Message::Text(msg.to_string().into()))
        .map_err(|e| e.to_string())
}
impl Drop for Channel {
    fn drop(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            cancel.cancel();
        }
    }
}
impl Channel {
    pub fn new(device_confirmation: bool, streaming: bool) -> Self {
        let mut channel = Self::default();
        channel.device_confirmation = device_confirmation;
        channel.streaming = streaming;
        channel
    }
    fn reset(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            cancel.cancel();
        }
        self.id = None;
        self.session = None;
        self.upload = None;
        self.rx = None;
        self.playback = None;
        self.started = None;
        self.recording_seconds = 0;
        self.decisions = None;
        self.confirmation = None;
        self.response_sent = false;
    }
    fn error(&mut self, ws: &mut WebSocket<TcpStream>, message: &str) -> Result<(), String> {
        let id = self.id.clone();
        self.reset();
        wire(ws, json!({"type":"voice_error","id":id,"message":message}))
    }
    fn decide(&mut self, nonce: &str, allowed: bool) -> Result<bool, &'static str> {
        if !self
            .confirmation
            .as_ref()
            .is_some_and(|card| !card.desktop_only && card.nonce == nonce)
        {
            return Ok(false);
        }
        let card = self.confirmation.take().unwrap();
        self.decisions
            .as_ref()
            .ok_or("确认通道已关闭")?
            .try_send(crate::device_agent::Decision {
                nonce: card.nonce,
                allowed,
            })
            .map_err(|_| "确认通道不可用")?;
        Ok(true)
    }
    pub fn binary(&mut self, ws: &mut WebSocket<TcpStream>, data: &[u8]) -> Result<(), String> {
        if let Some(upload) = &mut self.upload {
            if let Err(error) = upload.push(data) {
                return self.error(ws, &error);
            }
        }
        Ok(())
    }
    pub fn json(
        &mut self,
        app: &AppHandle,
        device: &str,
        ws: &mut WebSocket<TcpStream>,
        msg: &Value,
    ) -> Result<bool, String> {
        let kind = msg["type"].as_str().unwrap_or("");
        if !kind.starts_with("voice_") {
            return Ok(false);
        }
        let id = msg["id"].as_str().unwrap_or("");
        if kind == "voice_start" {
            if id.is_empty()
                || id.len() > 64
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                wire(
                    ws,
                    json!({"type":"voice_error","id":id,"message":"语音请求 ID 无效"}),
                )?;
                return Ok(true);
            }
            if VOICE_GATE.available_permits() == 0 {
                wire(
                    ws,
                    json!({"type":"voice_error","id":id,"message":"上一轮语音正在结束，请稍后重试"}),
                )?;
                return Ok(true);
            }
            if self.id.is_some() || self.seen.iter().any(|seen| seen == id) {
                wire(
                    ws,
                    json!({"type":"voice_error","id":id,"message":"请等待上一轮语音结束，或使用新的请求 ID"}),
                )?;
                return Ok(true);
            }
            if msg["sampleRate"] != 16000 || msg["channels"] != 1 || msg["format"] != "pcm_s16le" {
                wire(
                    ws,
                    json!({"type":"voice_error","id":id,"message":"只支持16kHz单声道PCM16录音"}),
                )?;
                return Ok(true);
            }
            if self.seen.len() >= 32 {
                self.seen.pop_front();
            }
            let session = msg.get("sessionId").and_then(Value::as_str);
            if msg.get("sessionId").is_some() && !session.is_some_and(valid_session) {
                wire(
                    ws,
                    json!({"type":"voice_error","id":id,"message":"聊天会话标识无效"}),
                )?;
                return Ok(true);
            }
            self.session = session.map(str::to_owned);
            self.seen.push_back(id.to_owned());
            crate::speech::prewarm_voice_recognition(app.clone());
            self.id = Some(id.to_owned());
            self.started = Some(Instant::now());
            self.upload = match Upload::new(id.to_owned()) {
                Ok(upload) => Some(upload),
                Err(error) => {
                    self.error(ws, &error)?;
                    return Ok(true);
                }
            };
            wire(
                ws,
                json!({"type":"voice_status","id":id,"stage":"listening"}),
            )?;
        } else if self.id.as_deref() == Some(id) {
            match kind {
                "voice_end" => {
                    if let Some(upload) = self.upload.take() {
                        match upload.finish() {
                            Ok((id, recording)) => {
                                self.started = Some(std::time::Instant::now());
                                self.recording_seconds = recording.bytes / (SAMPLE_RATE as u64 * 2);
                                let (tx, rx) = mpsc::channel();
                                let cancel = CancellationToken::new();
                                let (decision_tx, decision_rx) = tokio::sync::mpsc::channel(4);
                                self.decisions = Some(decision_tx);
                                spawn(
                                    app.clone(),
                                    VoiceTurn {
                                        device: device.to_owned(),
                                        session: self.session.clone(),
                                        id,
                                        device_confirmation: self.device_confirmation,
                                        streaming: self.streaming,
                                    },
                                    recording,
                                    tx,
                                    cancel.clone(),
                                    decision_rx,
                                );
                                self.rx = Some(rx);
                                self.cancel = Some(cancel);
                            }
                            Err(e) => self.error(ws, &e)?,
                        }
                    }
                }
                "voice_cancel" => {
                    self.reset();
                    wire(
                        ws,
                        json!({"type":"voice_status","id":id,"stage":"cancelled"}),
                    )?;
                }
                "voice_confirm" | "voice_reject" => {
                    if let Err(error) = self.decide(
                        msg["confirmationId"].as_str().unwrap_or(""),
                        kind == "voice_confirm",
                    ) {
                        self.error(ws, error)?;
                    }
                }
                "voice_credit" => {
                    if let Some(playback) = &mut self.playback {
                        let count = msg["count"]
                            .as_u64()
                            .filter(|n| (1..=4).contains(n))
                            .unwrap_or(0) as usize;
                        playback.credits = (playback.credits + count).min(4);
                    }
                }
                "voice_played" if self.playback.as_ref().is_some_and(|p| p.ended) => {
                    self.reset();
                    wire(ws, json!({"type":"voice_status","id":id,"stage":"done"}))?;
                }
                _ => (),
            }
        }
        Ok(true)
    }
    pub fn poll(&mut self, ws: &mut WebSocket<TcpStream>) -> Result<(), String> {
        let Some(id) = self.id.clone() else {
            return Ok(());
        };
        if (self.upload.is_none()
            && self
                .started
                .is_some_and(|at| at.elapsed() > Duration::from_secs(420 + self.recording_seconds)))
            || self
                .upload
                .as_ref()
                .is_some_and(|u| u.last_received.elapsed() > Duration::from_secs(15))
        {
            return self.error(ws, "语音操作超时，请重试");
        }
        let updates: Vec<_> = self
            .rx
            .as_ref()
            .map(|rx| rx.try_iter().collect())
            .unwrap_or_default();
        for update in updates {
            match update {
                Update::Stage(stage) => {
                    // Progress is not a resolution. Never hide an outstanding card.
                    if self.confirmation.is_some() {
                        continue;
                    }
                    wire(ws, json!({"type":"voice_status","id":id,"stage":stage}))?
                }
                Update::Transcript(text) => {
                    wire(ws, json!({"type":"voice_transcript","id":id,"text":text}))?
                }
                Update::ConfirmationResolved(nonce) => {
                    if self
                        .confirmation
                        .as_ref()
                        .is_some_and(|card| card.nonce == nonce)
                    {
                        self.confirmation = None;
                        wire(
                            ws,
                            json!({"type":"voice_confirmation_resolved","id":id,"confirmationId":nonce}),
                        )?;
                        wire(ws, json!({"type":"voice_status","id":id,"stage":"working"}))?;
                    }
                }
                Update::Confirmation(card) => {
                    if self
                        .confirmation
                        .as_ref()
                        .is_some_and(|current| current.nonce == card.nonce)
                    {
                        continue;
                    }
                    wire(
                        ws,
                        json!({"type":"voice_confirmation","id":id,"confirmationId":card.nonce,"message":card.message,"desktopOnly":card.desktop_only}),
                    )?;
                    self.confirmation = Some(card);
                }
                Update::Response(text) => {
                    wire(ws, json!({"type":"voice_reply","id":id,"text":text}))?;
                    self.response_sent = true;
                }
                Update::Notice(message) => {
                    wire(ws, json!({"type":"voice_notice","id":id,"message":message}))?;
                }
                Update::Error(e) => return self.error(ws, &e),
                Update::Stream { text, rx, result } => {
                    if !self.response_sent {
                        wire(ws, json!({"type":"voice_reply","id":id,"text":text}))?;
                        self.response_sent = true;
                    }
                    self.playback = Some(Playback {
                        pcm: Vec::new(),
                        offset: 0,
                        credits: 4,
                        ended: false,
                        stream: Some(rx),
                        result: Some(result),
                        source_done: false,
                        announced: false,
                        total: 0,
                    });
                }
                Update::Reply { text, pcm, warning } => {
                    if !self.response_sent {
                        wire(ws, json!({"type":"voice_reply","id":id,"text":text}))?;
                        self.response_sent = true;
                    }
                    if pcm.is_empty() {
                        self.reset();
                        wire(
                            ws,
                            json!({"type":"voice_status","id":id,"stage":"text_only","message":warning}),
                        )?;
                        return Ok(());
                    }
                    wire(
                        ws,
                        json!({"type":"voice_audio","id":id,"sampleRate":16000,"channels":1,"format":"pcm_s16le","bytes":pcm.len()}),
                    )?;
                    self.playback = Some(Playback {
                        pcm,
                        offset: 0,
                        credits: 4,
                        ended: false,
                        stream: None,
                        result: None,
                        source_done: true,
                        announced: true,
                        total: 0,
                    });
                }
            }
        }
        if let Some(playback) = &mut self.playback {
            if let Some(result) = playback.result.as_mut() {
                match result.try_recv() {
                    Ok(Ok(())) => {
                        playback.result = None;
                        playback.source_done = true;
                    }
                    Ok(Err(e)) => return self.error(ws, &e),
                    Err(tokio::sync::oneshot::error::TryRecvError::Closed) => {
                        return self.error(ws, "语音生成任务意外结束，请重试")
                    }
                    Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {}
                }
            }
            while playback.credits > 0 {
                if playback.offset == playback.pcm.len() {
                    if let Some(stream) = playback.stream.as_mut() {
                        match stream.try_recv() {
                            Ok(pcm) => {
                                if pcm.is_empty()
                                    || pcm.len() > AUDIO_CHUNK
                                    || pcm.len() % 2 != 0
                                    || playback.total + pcm.len() > MAX_REPLY_BYTES
                                {
                                    return self.error(ws, "流式音频数据无效或超过40秒");
                                }
                                playback.pcm = pcm;
                                playback.offset = 0;
                                if !playback.announced {
                                    wire(
                                        ws,
                                        json!({"type":"voice_audio","id":id,"sampleRate":16000,"channels":1,"format":"pcm_s16le","bytes":0,"stream":true}),
                                    )?;
                                    playback.announced = true;
                                }
                            }
                            Err(_) => break,
                        }
                    } else {
                        break;
                    }
                }
                let end = (playback.offset + AUDIO_CHUNK).min(playback.pcm.len());
                ws.send(Message::Binary(
                    playback.pcm[playback.offset..end].to_vec().into(),
                ))
                .map_err(|e| e.to_string())?;
                playback.total += end - playback.offset;
                playback.offset = end;
                playback.credits -= 1;
            }
            let drained = playback.stream.as_ref().is_none_or(|rx| rx.is_empty());
            if playback.source_done
                && drained
                && playback.offset == playback.pcm.len()
                && !playback.ended
            {
                if !playback.announced {
                    return self.error(ws, "MiMo 未返回有效的语音数据");
                }
                wire(
                    ws,
                    json!({"type":"voice_audio_end","id":id,"bytes":playback.total}),
                )?;
                playback.ended = true;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod channel_tests {
    use super::*;
    fn sockets() -> (WebSocket<TcpStream>, std::thread::JoinHandle<Vec<Message>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let client = std::thread::spawn(move || {
            let stream = TcpStream::connect(addr).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let (mut ws, _) = tungstenite::client(format!("ws://{addr}"), stream).unwrap();
            let mut messages = Vec::new();
            while let Ok(message) = ws.read() {
                let done =
                    message.is_text() && message.to_text().unwrap().contains("voice_audio_end");
                messages.push(message);
                if done {
                    break;
                }
            }
            messages
        });
        let (stream, _) = listener.accept().unwrap();
        (tungstenite::accept(stream).unwrap(), client)
    }
    #[test]
    fn active_upload_outlives_old_session_deadline_and_cancel_removes_file() {
        let (mut ws, client) = sockets();
        let mut voice = Channel::default();
        voice.id = Some("long-1".into());
        voice.started = Some(Instant::now() - Duration::from_secs(1000));
        let upload = Upload::new("long-1".into()).unwrap();
        let path = upload.recording.file.path().to_owned();
        voice.upload = Some(upload);
        voice.poll(&mut ws).unwrap();
        assert!(voice.upload.is_some());
        voice.reset();
        assert!(!path.exists());
        wire(&mut ws, json!({"type":"voice_audio_end"})).unwrap();
        client.join().unwrap();
    }

    #[test]
    fn confirmation_survives_progress_and_only_matching_resolution_clears_it() {
        let (mut ws, client) = sockets();
        let mut voice = Channel::default();
        voice.id = Some("card-turn".into());
        voice.started = Some(Instant::now());
        let (tx, rx) = mpsc::channel();
        voice.rx = Some(rx);
        tx.send(Update::Confirmation(crate::device_agent::Confirmation {
            nonce: "card-1".into(),
            message: "创建日程".into(),
            desktop_only: false,
        }))
        .unwrap();
        tx.send(Update::Stage("working")).unwrap();
        tx.send(Update::Notice("正在等待操作确认".into())).unwrap();
        voice.poll(&mut ws).unwrap();
        assert_eq!(voice.confirmation.as_ref().unwrap().nonce, "card-1");
        tx.send(Update::ConfirmationResolved("old-card".into()))
            .unwrap();
        voice.poll(&mut ws).unwrap();
        assert!(voice.confirmation.is_some());
        tx.send(Update::ConfirmationResolved("card-1".into()))
            .unwrap();
        voice.poll(&mut ws).unwrap();
        assert!(voice.confirmation.is_none());
        drop(ws);
        let types: Vec<_> = client
            .join()
            .unwrap()
            .iter()
            .filter_map(|m| m.to_text().ok())
            .filter_map(|t| serde_json::from_str::<Value>(t).ok())
            .filter_map(|v| v["type"].as_str().map(str::to_owned))
            .collect();
        let resolved = types
            .iter()
            .position(|t| t == "voice_confirmation_resolved")
            .unwrap();
        assert!(!types[..resolved].iter().any(|t| t == "voice_status"));
        assert_eq!(
            types.iter().filter(|t| *t == "voice_confirmation").count(),
            1
        );
    }

    #[test]
    fn session_ids_are_bounded_wire_identifiers() {
        assert!(valid_session("boot-123-chat-2"));
        assert!(valid_session("session_a"));
        for bad in ["", "../old", "中文", "a b"] {
            assert!(!valid_session(bad));
        }
        assert!(!valid_session(&"x".repeat(65)));
    }

    #[test]
    fn reply_text_arrives_before_audio_and_is_not_duplicated() {
        let (mut ws, client) = sockets();
        let mut voice = Channel::default();
        voice.id = Some("early-text".into());
        voice.started = Some(Instant::now());
        let (tx, rx) = mpsc::channel();
        voice.rx = Some(rx);
        tx.send(Update::Response("你好".into())).unwrap();
        tx.send(Update::Stage("synthesizing")).unwrap();
        voice.poll(&mut ws).unwrap();
        // Text must already have been sent while audio synthesis is pending.
        assert!(voice.response_sent);
        assert!(voice.playback.is_none());
        tx.send(Update::Reply {
            text: "你好".into(),
            pcm: vec![0; AUDIO_CHUNK],
            warning: None,
        })
        .unwrap();
        voice.poll(&mut ws).unwrap();
        drop(ws);
        let messages = client.join().unwrap();
        let types: Vec<_> = messages
            .iter()
            .filter_map(|m| m.to_text().ok())
            .filter_map(|t| serde_json::from_str::<Value>(t).ok())
            .filter_map(|v| v["type"].as_str().map(str::to_owned))
            .collect();
        assert_eq!(types.iter().filter(|t| *t == "voice_reply").count(), 1);
        assert!(
            types.iter().position(|t| t == "voice_reply").unwrap()
                < types.iter().position(|t| t == "voice_audio").unwrap()
        );
        voice.reset();
        assert!(!voice.response_sent);
    }

    #[test]
    fn streamed_playback_starts_before_eof_and_finishes_with_exact_bytes() {
        let (mut ws, client) = sockets();
        let mut voice = Channel::default();
        voice.id = Some("stream-1".into());
        voice.started = Some(Instant::now());
        let (tx, rx) = mpsc::channel();
        voice.rx = Some(rx);
        let (audio, stream) = tokio::sync::mpsc::channel(4);
        let (done, result) = tokio::sync::oneshot::channel();
        tx.send(Update::Stream {
            text: "流式回复".into(),
            rx: stream,
            result,
        })
        .unwrap();
        for n in 0..4 {
            audio.try_send(vec![n; AUDIO_CHUNK]).unwrap();
        }
        voice.poll(&mut ws).unwrap();
        assert_eq!(voice.playback.as_ref().unwrap().total, AUDIO_CHUNK * 4);
        assert!(!voice.playback.as_ref().unwrap().ended);
        audio.try_send(vec![4; AUDIO_CHUNK]).unwrap();
        drop(audio);
        done.send(Ok(())).unwrap();
        voice.poll(&mut ws).unwrap();
        assert!(!voice.playback.as_ref().unwrap().ended);
        voice.playback.as_mut().unwrap().credits = 1;
        voice.poll(&mut ws).unwrap();
        assert!(voice.playback.as_ref().unwrap().ended);
        drop(ws);
        let messages = client.join().unwrap();
        let chunks: Vec<_> = messages
            .iter()
            .filter_map(|m| {
                if let Message::Binary(b) = m {
                    Some(b)
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(chunks.len(), 5);
        let end = messages
            .iter()
            .filter_map(|m| {
                if let Message::Text(t) = m {
                    serde_json::from_str::<Value>(t).ok()
                } else {
                    None
                }
            })
            .find(|j| j["type"] == "voice_audio_end")
            .unwrap();
        assert_eq!(end["bytes"], AUDIO_CHUNK * 5);
    }
    #[test]
    fn interrupted_stream_cancels_playback_instead_of_signalling_success() {
        let (mut ws, client) = sockets();
        let mut voice = Channel::default();
        voice.id = Some("stream-2".into());
        voice.started = Some(Instant::now());
        let (tx, rx) = mpsc::channel();
        voice.rx = Some(rx);
        let (audio, stream) = tokio::sync::mpsc::channel(4);
        let (done, result) = tokio::sync::oneshot::channel();
        tx.send(Update::Stream {
            text: "部分语音".into(),
            rx: stream,
            result,
        })
        .unwrap();
        audio.try_send(vec![0; AUDIO_CHUNK]).unwrap();
        voice.poll(&mut ws).unwrap();
        drop(audio);
        done.send(Err("网络中断".into())).unwrap();
        voice.poll(&mut ws).unwrap();
        assert!(voice.playback.is_none());
        drop(ws);
        let messages = client.join().unwrap();
        assert!(!messages
            .iter()
            .any(|m| m.to_text().is_ok_and(|t| t.contains("voice_audio_end"))));
    }
    #[test]
    fn playback_waits_for_credit_and_keeps_pcm_order() {
        let (mut ws, client) = sockets();
        let mut voice = Channel::default();
        voice.id = Some("turn-1".into());
        voice.started = Some(Instant::now());
        let (tx, rx) = mpsc::channel();
        voice.rx = Some(rx);
        let pcm: Vec<u8> = (0..AUDIO_CHUNK * 5).map(|n| (n % 251) as u8).collect();
        tx.send(Update::Reply {
            text: "你好".into(),
            pcm: pcm.clone(),
            warning: None,
        })
        .unwrap();
        voice.poll(&mut ws).unwrap();
        assert_eq!(voice.playback.as_ref().unwrap().offset, AUDIO_CHUNK * 4);
        voice.poll(&mut ws).unwrap();
        assert_eq!(voice.playback.as_ref().unwrap().offset, AUDIO_CHUNK * 4);
        voice.playback.as_mut().unwrap().credits = 1;
        voice.poll(&mut ws).unwrap();
        assert!(voice.playback.as_ref().unwrap().ended);
        let packets = client.join().unwrap();
        let actual: Vec<u8> = packets
            .into_iter()
            .filter_map(|p| match p {
                Message::Binary(data) => Some(data.to_vec()),
                _ => None,
            })
            .flatten()
            .collect();
        assert_eq!(actual, pcm);
    }
    #[test]
    fn confirmation_is_exact_single_use_and_cannot_approve_desktop_controls() {
        let mut channel = Channel::default();
        let (tx, mut rx) = tokio::sync::mpsc::channel(4);
        channel.decisions = Some(tx);
        channel.confirmation = Some(crate::device_agent::Confirmation {
            nonce: "current".into(),
            message: "创建提醒".into(),
            desktop_only: false,
        });
        assert!(!channel.decide("stale", true).unwrap());
        assert!(rx.try_recv().is_err());
        assert!(channel.decide("current", true).unwrap());
        let decision = rx.try_recv().unwrap();
        assert_eq!(decision.nonce, "current");
        assert!(decision.allowed);
        assert!(!channel.decide("current", true).unwrap());
        assert!(rx.try_recv().is_err());
        channel.confirmation = Some(crate::device_agent::Confirmation {
            nonce: "desktop".into(),
            message: "运行命令".into(),
            desktop_only: true,
        });
        assert!(!channel.decide("desktop", true).unwrap());
        assert!(rx.try_recv().is_err());
        channel.confirmation = Some(crate::device_agent::Confirmation {
            nonce: "next".into(),
            message: "保存备忘".into(),
            desktop_only: false,
        });
        assert!(!channel.decide("current", true).unwrap());
        assert!(channel.decide("next", false).unwrap());
        assert!(!rx.try_recv().unwrap().allowed);
    }
    #[test]
    fn cancel_clears_audio_and_signals_worker() {
        let cancel = CancellationToken::new();
        let mut channel = Channel::default();
        channel.id = Some("voice-1".into());
        channel.cancel = Some(cancel.clone());
        channel.upload = Some(Upload::new("voice-1".into()).unwrap());
        channel.reset();
        assert!(cancel.is_cancelled());
        assert!(channel.id.is_none());
        assert!(channel.upload.is_none());
        let cancel = CancellationToken::new();
        {
            let mut channel = Channel::default();
            channel.cancel = Some(cancel.clone());
        }
        assert!(cancel.is_cancelled());
    }
}
