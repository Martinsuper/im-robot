//! 唤醒后的语音回合：指令转写 → Agent 执行 → 语音播报。
//! 与 Passport 设备语音共用 Agent 执行链（device_agent::run），
//! 操作内容播报后直接接收确认/取消，无需再次唤醒或点击桌面卡片。
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

use super::{publish, Stage, STATE};

/// 单回合总上限：委派任务可能较久，超时提示到桌面查看。
const TURN_TIMEOUT: Duration = Duration::from_secs(600);
/// 播报文本上限（与 Passport 设备语音一致）。
const SPEECH_TEXT_LIMIT: usize = 240;
/// 只喊唤醒词（无后续指令）时的本地应答。
const GREETING: &str = "我在，请说。";
/// 设备标识：所有桌面语音回合落在同一会话，便于在对话窗口回看。
const DEVICE_ID: &str = "desktop-voice";

static VOICE_GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

/// One wake owns the microphone conversation until inactivity or an explicit goodbye.
pub(crate) async fn run_turn(app: AppHandle, utterance: Vec<f32>) {
    // 同一时刻只允许一个回合；permit 持有到回合结束（与 Passport 设备语音同款门）。
    let Ok(_permit) = VOICE_GATE.try_acquire() else {
        // 已有回合在跑：worker 端本就抑制重复唤醒，这里只兜底。
        return;
    };
    let started = std::time::Instant::now();
    let message = conversation(&app, utterance).await.err();
    if let Some(error) = message.as_deref() {
        if super::assistant_enabled(&app) {
            publish(&app, Stage::Speaking, "", error, "");
            let _ = speak_text(&app, error).await;
        }
    }
    eprintln!(
        "[voice-assistant] 连续对话结束 ok={} ms={}",
        message.is_none(),
        started.elapsed().as_millis()
    );
    STATE.finish_turn(&app, message);
}

async fn conversation(app: &AppHandle, mut audio: Vec<f32>) -> Result<(), String> {
    let mut first_turn = true;
    loop {
        if !super::assistant_enabled(app) {
            return Ok(());
        }
        let started = std::time::Instant::now();
        let outcome = tokio::time::timeout(TURN_TIMEOUT, turn(app.clone(), audio, first_turn))
            .await
            .map_err(|_| "语音回合超时，任务已停止；此前完成的操作可稍后查看记录".to_string())??;
        eprintln!(
            "[voice-assistant] 回合结束 ok=true ms={}",
            started.elapsed().as_millis()
        );
        if outcome == TurnOutcome::Finished || !super::assistant_enabled(app) {
            return Ok(());
        }
        first_turn = false;

        // Playback has finished; discard its tail before listening to the next utterance.
        tokio::time::sleep(Duration::from_millis(200)).await;
        publish(app, Stage::Listening, "", "", "可以继续说，或说结束对话");
        eprintln!("[voice-assistant] 继续聆听，无需再次唤醒（静默20秒结束）");
        let capture = STATE.request_capture(super::CaptureMode::FollowUp);
        audio = tokio::time::timeout(Duration::from_secs(35), capture)
            .await
            .map_err(|_| "后续录音超时".to_string())?
            .map_err(|_| "后续录音通道已关闭".to_string())??;
        if audio.is_empty() {
            eprintln!("[voice-assistant] 持续静默，恢复唤醒词监听");
            return Ok(());
        }
    }
}

#[derive(Debug, PartialEq)]
enum TurnOutcome {
    Continue,
    Finished,
}

#[derive(Debug, PartialEq)]
enum DialogueInput {
    WakeOnly,
    Finish,
    Prompt(String),
}

fn dialogue_input(transcript: &str, wake_word: &str) -> DialogueInput {
    let prompt = super::strip_wake_prefix(transcript, wake_word);
    let compact: String = prompt
        .chars()
        .filter(|c| !c.is_whitespace() && !"，。！？、,.!?；;：:".contains(*c))
        .collect();
    if !compact.chars().any(char::is_alphanumeric)
        || matches!(compact.as_str(), "我" | "然后" | "喂" | "嗯" | "啊")
    {
        return DialogueInput::WakeOnly;
    }
    if matches!(
        compact.as_str(),
        "结束对话" | "停止对话" | "不聊了" | "先这样" | "再见" | "没事了" | "不用了" | "取消"
    ) {
        DialogueInput::Finish
    } else {
        DialogueInput::Prompt(prompt)
    }
}

async fn turn(
    app: AppHandle,
    utterance: Vec<f32>,
    first_turn: bool,
) -> Result<TurnOutcome, String> {
    publish(&app, Stage::Thinking, "", "", "");
    let asr_at = std::time::Instant::now();
    let transcript = if utterance.is_empty() {
        String::new()
    } else {
        transcribe(app.clone(), utterance).await?
    };
    eprintln!(
        "[voice-assistant] 转写「{transcript}」 ms={}",
        asr_at.elapsed().as_millis()
    );
    // A noise-only follow-up must not greet again and keep the session alive forever.
    if !first_turn && !transcript.chars().any(char::is_alphanumeric) {
        return Ok(TurnOutcome::Finished);
    }
    publish(&app, Stage::Thinking, &transcript, "", "");
    let settings = crate::settings::read_settings(&app);
    let prompt = match dialogue_input(&transcript, &settings.voice_assistant_wake_word) {
        DialogueInput::WakeOnly => {
            publish(&app, Stage::Speaking, &transcript, GREETING, "");
            speak_text(&app, GREETING).await?;
            return Ok(TurnOutcome::Continue);
        }
        DialogueInput::Finish => {
            publish(
                &app,
                Stage::Speaking,
                &transcript,
                "好的，需要时再叫我。",
                "",
            );
            speak_text(&app, "好的，需要时再叫我。").await?;
            return Ok(TurnOutcome::Finished);
        }
        DialogueInput::Prompt(prompt) => prompt,
    };
    let agent_at = std::time::Instant::now();
    let response = if let Some(reply) = local_reply(&prompt) {
        reply
    } else {
        run_agent_turn(&app, &prompt).await?
    };
    eprintln!(
        "[voice-assistant] agent_ms={}",
        agent_at.elapsed().as_millis()
    );
    let text: String = crate::speech::text_for_speech(&response)
        .chars()
        .take(SPEECH_TEXT_LIMIT)
        .collect();
    if text.trim().is_empty() {
        return Ok(TurnOutcome::Continue);
    }
    publish(&app, Stage::Speaking, "", &text, "");
    speak_text(&app, &text).await?;
    Ok(TurnOutcome::Continue)
}

/// 本地 SenseVoice 转写（复用进程级模型缓存与串行 blocking 通道）。
async fn transcribe(app: AppHandle, utterance: Vec<f32>) -> Result<String, String> {
    crate::background::SUPERVISOR
        .blocking("speech-transcription", move || {
            let definition = crate::speech::speech_model_definitions()
                .first()
                .ok_or("未配置语音模型")?;
            crate::speech::transcribe_with_sense_voice(
                crate::speech::speech_model_path(&app, definition)?,
                crate::speech::sense_voice_tokens_path(&app, definition)?,
                utterance,
                16_000,
            )
        })
        .await
        .map_err(|error| format!("本地语音转写任务失败：{error}"))
}

/// Simple local questions avoid a network round trip entirely.
fn local_reply(prompt: &str) -> Option<String> {
    let text: String = prompt
        .chars()
        .filter(|c| !c.is_whitespace() && !"，。！？、,.!?".contains(*c))
        .collect();
    match text.as_str() {
        "现在几点" | "现在几点了" | "几点了" | "现在的时间" | "告诉我现在几点" => {
            Some(chrono::Local::now().format("现在是%-H点%M分").to_string())
        }
        _ => None,
    }
}

struct ConfirmationTask {
    nonce: String,
    task: tauri::async_runtime::JoinHandle<Result<crate::device_agent::Decision, String>>,
}
impl Drop for ConfirmationTask {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn confirm_by_voice(
    app: AppHandle,
    card: crate::device_agent::Confirmation,
) -> Result<crate::device_agent::Decision, String> {
    if card.desktop_only {
        publish(&app, Stage::Speaking, "", &card.message, "");
        // Unreviewable operations are rejected, rather than approved from a summary.
        play_speech(&app, &card.message).await?;
        return Ok(crate::device_agent::Decision {
            nonce: card.nonce,
            allowed: false,
        });
    }
    let question = format!("{}。请说确认或取消。", card.message);
    publish(&app, Stage::Speaking, "", &question, "");
    // Do not shorten or strip Markdown from the reviewed operation's exact fields.
    play_speech(&app, &question).await?;
    for attempt in 0..2 {
        if !super::assistant_enabled(&app) {
            return Err("语音助手已暂停".into());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        publish(&app, Stage::Listening, "", "", "请说确认或取消");
        let capture = super::STATE.request_capture(super::CaptureMode::Confirmation);
        let audio = tokio::time::timeout(Duration::from_secs(10), capture)
            .await
            .map_err(|_| "没有收到确认录音".to_string())?
            .map_err(|_| "确认录音通道已关闭".to_string())??;
        if !audio.is_empty() {
            let transcript = transcribe(app.clone(), audio).await?;
            eprintln!("[voice-assistant] 确认答复「{transcript}」");
            let settings = crate::settings::read_settings(&app);
            let transcript =
                super::strip_wake_prefix(&transcript, &settings.voice_assistant_wake_word);
            if let Some(allowed) = super::confirmation::decision(&transcript) {
                return Ok(crate::device_agent::Decision {
                    nonce: card.nonce,
                    allowed,
                });
            }
        }
        if attempt == 0 {
            publish(&app, Stage::Speaking, "", "没有听清，请说确认或取消。", "");
            speak_text(&app, "没有听清，请说确认或取消。").await?;
        }
    }
    publish(
        &app,
        Stage::Speaking,
        "",
        "没有收到明确确认，本次不执行。",
        "",
    );
    speak_text(&app, "没有收到明确确认，本次不执行。").await?;
    Ok(crate::device_agent::Decision {
        nonce: card.nonce,
        allowed: false,
    })
}

/// Agent and voice decisions run concurrently. Resolution invalidates any old recording.
async fn run_agent_turn(app: &AppHandle, prompt: &str) -> Result<String, String> {
    eprintln!("[voice-assistant] Agent 回合 prompt={prompt}");
    let (tx, rx) = std::sync::mpsc::channel::<crate::device_voice::Update>();
    // 持有 decision 发送端直到回合结束：通道关闭会让 device_agent 误判确认通道故障。
    let (decision_tx, decision_rx) = tokio::sync::mpsc::channel(4);
    let cancel = CancellationToken::new();
    let _cancel_on_drop = cancel.clone().drop_guard();
    let agent_cancel = cancel.clone();
    let turn_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or_default();
    let turn_id = format!("voice-{turn_at}");
    let owned_prompt = prompt.to_string();
    let agent_app = app.clone();
    let mut agent_task = tauri::async_runtime::spawn(async move {
        crate::device_agent::run(
            agent_app,
            crate::device_agent::DeviceTurn {
                device: DEVICE_ID,
                session: None,
                turn: &turn_id,
                prompt: owned_prompt,
            },
            &tx,
            &agent_cancel,
            decision_rx,
            crate::device_agent::ConfirmationMode::Voice,
        )
        .await
    });

    let (updates_tx, mut updates) = tokio::sync::mpsc::channel(32);
    let _drainer = std::thread::Builder::new()
        .name("voice-assistant-updates".into())
        .spawn(move || {
            while let Ok(update) = rx.recv() {
                if updates_tx.blocking_send(update).is_err() {
                    break;
                }
            }
        })
        .map_err(|_| "无法启动语音任务事件通道".to_string())?;
    let mut pending: Option<ConfirmationTask> = None;
    let mut updates_open = true;
    loop {
        tokio::select! {
            biased;
            update = updates.recv(), if updates_open => {
                match update {
                    Some(crate::device_voice::Update::Confirmation(card)) => {
                        if pending.as_ref().is_some_and(|p| p.nonce == card.nonce) { continue; }
                        pending = Some(ConfirmationTask {
                            nonce: card.nonce.clone(),
                            task: tauri::async_runtime::spawn(confirm_by_voice(app.clone(), card)),
                        });
                    }
                    Some(crate::device_voice::Update::ConfirmationResolved(nonce)) => {
                        if pending.as_ref().is_some_and(|p| p.nonce == nonce) {
                            pending = None;
                            publish(app, Stage::Thinking, "", "", "");
                        }
                    }
                    Some(crate::device_voice::Update::Notice(text)) => {
                        if pending.is_none() {
                            publish(app, Stage::Speaking, "", &text, "");
                            speak_text(app, &text).await?;
                            publish(app, Stage::Thinking, "", "", "");
                        }
                    }
                    None => updates_open = false,
                    _ => (),
                }
            }
            result = &mut agent_task => {
                return result.map_err(|_| "任务代理意外退出，请查看对话记录".to_string())?;
            }
            result = async { (&mut pending.as_mut().unwrap().task).await }, if pending.is_some() => {
                let current = pending.take().unwrap();
                let decision = match result {
                    Ok(Ok(decision)) => decision,
                    _ => {
                        // Recording/ASR/TTS failures never become approval.
                        let message = "未能完成语音确认，本次操作不执行。";
                        if super::assistant_enabled(app) {
                            publish(app, Stage::Speaking, "", message, "");
                            let _ = speak_text(app, message).await;
                        }
                        crate::device_agent::Decision { nonce: current.nonce.clone(), allowed: false }
                    }
                };
                if !super::assistant_enabled(app) { return Err("语音助手已暂停，操作未确认".into()); }
                decision_tx.send(decision).await.map_err(|_| "确认已失效".to_string())?;
                publish(app, Stage::Thinking, "", "", "");
            }
        }
    }
}

/// 按 TTS 设置播报：MiMo 流式播放，其余走系统语音（say/SAPI）。
async fn speak_text(app: &AppHandle, text: &str) -> Result<(), String> {
    let speech: String = crate::speech::text_for_speech(text)
        .chars()
        .take(SPEECH_TEXT_LIMIT)
        .collect();
    play_speech(app, &speech).await
}

async fn play_speech(app: &AppHandle, speech: &str) -> Result<(), String> {
    if speech.trim().is_empty() {
        return Ok(());
    }
    let started = std::time::Instant::now();
    let cancel = CancellationToken::new();
    let _cancel_on_drop = cancel.clone().drop_guard();
    #[cfg(target_os = "macos")]
    if crate::tts::settings(app)?.provider == "system" {
        // say plays while synthesizing; generating a whole WAV first delays first audio.
        let input = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
        tokio::fs::write(input.path(), speech)
            .await
            .map_err(|e| e.to_string())?;
        let mut command = tokio::process::Command::new("/usr/bin/say");
        if speech
            .chars()
            .any(|c| ('\u{3400}'..='\u{9fff}').contains(&c))
        {
            command.args(["-v", "Tingting"]);
        }
        let result = command
            .arg("-f")
            .arg(input.path())
            .kill_on_drop(true)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await
            .map_err(|e| format!("系统语音播放失败：{e}"))?;
        if !result.success() {
            return Err("系统语音播放失败".into());
        }
        eprintln!(
            "[voice-assistant] speech_ms={} provider=system",
            started.elapsed().as_millis()
        );
        return Ok(());
    }
    if crate::tts::settings(app)?.provider == "mimo" {
        let (audio_tx, mut audio_rx) = tokio::sync::mpsc::channel(4);
        let synth = crate::tts_stream::synthesize(app, speech, audio_tx);
        let player =
            tauri::async_runtime::spawn_blocking(move || playback_stream(&mut audio_rx, &cancel));
        let (generated, played) = tokio::join!(synth, player);
        generated?;
        played.map_err(|_| "语音播放任务异常".to_string())??;
        eprintln!(
            "[voice-assistant] speech_ms={} provider=mimo",
            started.elapsed().as_millis()
        );
        return Ok(());
    }
    let pcm = crate::tts::synthesize_pcm(app, speech).await?;
    crate::background::SUPERVISOR
        .blocking("voice-assistant-playback", move || {
            playback_pcm(&pcm, &cancel)
        })
        .await
        .map_err(|error| format!("语音播放任务失败：{error}"))
}

fn samples_buffer(pcm: &[u8]) -> rodio::buffer::SamplesBuffer {
    let samples: Vec<f32> = pcm
        .as_chunks::<2>()
        .0
        .iter()
        .map(|bytes| i16::from_le_bytes(*bytes) as f32 / 32768.0)
        .collect();
    rodio::buffer::SamplesBuffer::new(1, 16_000, samples)
}

fn playback_pcm(pcm: &[u8], cancel: &CancellationToken) -> Result<(), String> {
    let mut output =
        rodio::OutputStreamBuilder::open_default_stream().map_err(|_| "无法打开音频输出设备")?;
    output.log_on_drop(false);
    let sink = rodio::Sink::connect_new(output.mixer());
    sink.append(samples_buffer(pcm));
    while !sink.empty() {
        if cancel.is_cancelled() {
            sink.stop();
            return Err("播报已取消".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}

fn playback_stream(
    rx: &mut tokio::sync::mpsc::Receiver<Vec<u8>>,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let started = std::time::Instant::now();
    let mut first_audio = true;
    let mut output =
        rodio::OutputStreamBuilder::open_default_stream().map_err(|_| "无法打开音频输出设备")?;
    output.log_on_drop(false);
    let sink = rodio::Sink::connect_new(output.mixer());
    loop {
        if cancel.is_cancelled() {
            sink.stop();
            return Err("播报已取消".into());
        }
        let pcm = match rx.try_recv() {
            Ok(pcm) => pcm,
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => break,
            Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }
        };
        if pcm.is_empty() {
            continue;
        }
        if first_audio {
            first_audio = false;
            eprintln!(
                "[voice-assistant] speech_first_audio_ms={}",
                started.elapsed().as_millis()
            );
        }
        sink.append(samples_buffer(&pcm));
        while sink.len() >= 8 {
            if cancel.is_cancelled() {
                sink.stop();
                return Err("播报已取消".into());
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    while !sink.empty() {
        if cancel.is_cancelled() {
            sink.stop();
            return Err("播报已取消".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn one_wake_allows_commands_without_a_repeated_prefix_and_an_explicit_goodbye() {
        assert_eq!(
            dialogue_input("你好，皮可。", "你好皮可"),
            DialogueInput::WakeOnly
        );
        assert_eq!(
            dialogue_input("现在几点？", "你好皮可"),
            DialogueInput::Prompt("现在几点？".into())
        );
        assert_eq!(
            dialogue_input("我明天有什么日程？", "你好皮可"),
            DialogueInput::Prompt("我明天有什么日程？".into())
        );
        assert_eq!(
            dialogue_input("结束对话。", "你好皮可"),
            DialogueInput::Finish
        );
        assert_eq!(
            dialogue_input("你好皮可，再见", "你好皮可"),
            DialogueInput::Finish
        );
        for text in ["创建一个叫再见的备忘录", "取消明天的日程", "停止专注"] {
            assert!(matches!(
                dialogue_input(text, "你好皮可"),
                DialogueInput::Prompt(_)
            ));
        }
    }
    #[test]
    fn local_time_reply_never_intercepts_an_operation_request() {
        assert!(local_reply("现在几点了？").unwrap().starts_with("现在是"));
        for prompt in ["记录一下当前时间", "明天几点开会", "现在几点，帮我创建日程"]
        {
            assert!(local_reply(prompt).is_none());
        }
    }
}
