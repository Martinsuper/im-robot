//! 24 小时常驻语音助手：本地唤醒词检测 → 语音指令 → Agent 回合 → 语音播报。
//! 音频全程不出本机：非唤醒语音只参与本地关键词概率计算，指令转写用后即弃；
//! 开关关闭或感知暂停时完全不打开麦克风（macOS 麦克风占用指示同步熄灭）。
pub(crate) mod commands;
mod confirmation;
mod kws;
mod mic;
mod session;

#[cfg(test)]
mod tests;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use sherpa_onnx::LinearResampler;
use tauri::{AppHandle, Emitter};

use crate::background::Worker;

/// 唤醒词命中后的指令录音上限；超出按已有音频收尾。
const MAX_UTTERANCE: Duration = Duration::from_secs(12);
/// 静音多久判定一句话说完。
const TRAILING_SILENCE: Duration = Duration::from_millis(800);
/// 判定语音的最短能量时长（唤醒词本身计入）。
const MIN_SPEECH: Duration = Duration::from_millis(200);
/// 回合结束后的唤醒冷却：覆盖 TTS 播放尾声与回声衰减。
const TURN_COOLDOWN: Duration = Duration::from_secs(2);
/// KWS 每次喂入的音频块（100ms @16kHz）。
const FEED_BLOCK: usize = 1_600;
/// 麦克风数据断流多久判定设备失联并重建。
const MIC_STALL: Duration = Duration::from_secs(4);
/// 能量端点窗口（100ms @16kHz）。
const GATE_WINDOW: usize = 1_600;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Stage {
    Idle,
    Listening,
    Thinking,
    Speaking,
}

impl Stage {
    fn as_str(self) -> &'static str {
        match self {
            Stage::Idle => "idle",
            Stage::Listening => "listening",
            Stage::Thinking => "thinking",
            Stage::Speaking => "speaking",
        }
    }
}

#[derive(Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AssistantEvent {
    stage: &'static str,
    transcript: String,
    reply: String,
    message: String,
}

struct Shared {
    stage: Mutex<Stage>,
    last: Mutex<Option<AssistantEvent>>,
    error: Mutex<Option<String>>,
    cooldown_until: Mutex<Instant>,
    manual_trigger: AtomicU64,
    capture: Mutex<Option<CaptureRequest>>,
}

#[derive(Clone, Copy)]
enum CaptureMode {
    Confirmation,
    FollowUp,
}

struct CaptureRequest {
    mode: CaptureMode,
    reply: tokio::sync::oneshot::Sender<Result<Vec<f32>, String>>,
}

static STATE: LazyLock<Shared> = LazyLock::new(Shared::default);

impl Default for Shared {
    fn default() -> Self {
        Self {
            stage: Mutex::new(Stage::Idle),
            last: Mutex::new(None),
            error: Mutex::new(None),
            cooldown_until: Mutex::new(Instant::now()),
            manual_trigger: AtomicU64::new(0),
            capture: Mutex::new(None),
        }
    }
}

impl Shared {
    /// 更新缓存并向 bubble/pet 广播状态；与上次完全相同的事件不重复发送。
    fn publish(&self, app: &AppHandle, stage: Stage, transcript: &str, reply: &str, message: &str) {
        let event = AssistantEvent {
            stage: stage.as_str(),
            transcript: transcript.to_string(),
            reply: reply.to_string(),
            message: message.to_string(),
        };
        *self.stage.lock().unwrap_or_else(|e| e.into_inner()) = stage;
        if message.is_empty() {
            *self.error.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
        let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
        if last.as_ref() == Some(&event) {
            return;
        }
        *last = Some(event.clone());
        drop(last);
        for window in ["bubble", "pet"] {
            let _ = app.emit_to(window, "voice-assistant-state", &event);
        }
    }

    /// 只有空闲且冷却结束时才允许新的唤醒。
    fn is_free(&self) -> bool {
        *self.stage.lock().unwrap_or_else(|e| e.into_inner()) == Stage::Idle
            && Instant::now()
                >= *self
                    .cooldown_until
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
    }

    /// 回合收尾：回到空闲、进入冷却并展示错误（若有）。
    fn finish_turn(&self, app: &AppHandle, error: Option<String>) {
        if let Some(message) = error {
            *self.error.lock().unwrap_or_else(|e| e.into_inner()) = Some(message.clone());
            self.publish(app, Stage::Idle, "", "", &message);
        } else {
            self.publish(app, Stage::Idle, "", "", "");
        }
        *self
            .cooldown_until
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Instant::now() + TURN_COOLDOWN;
    }

    fn request_manual_trigger(&self) {
        self.manual_trigger.fetch_add(1, Ordering::Relaxed);
    }

    /// worker 每轮对账：是否有未消费的手动触发请求。
    fn take_manual_trigger(&self, seen: &mut u64) -> bool {
        let current = self.manual_trigger.load(Ordering::Relaxed);
        if current == *seen {
            return false;
        }
        *seen = current;
        true
    }

    fn request_capture(
        &self,
        mode: CaptureMode,
    ) -> tokio::sync::oneshot::Receiver<Result<Vec<f32>, String>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        *self.capture.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(CaptureRequest { mode, reply: tx });
        rx
    }
}

/// 模块内部状态发布入口。
fn publish(app: &AppHandle, stage: Stage, transcript: &str, reply: &str, message: &str) {
    STATE.publish(app, stage, transcript, reply, message);
}

/// 状态快照（供命令层查询）；事件缓存为空时按当前 stage 生成默认值。
pub(crate) fn status_snapshot(
    settings: &crate::app_settings::AppSettings,
    model_ready: bool,
) -> commands::VoiceAssistantStatus {
    let stage = *STATE.stage.lock().unwrap_or_else(|e| e.into_inner());
    let last = STATE
        .last
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .unwrap_or(AssistantEvent {
            stage: stage.as_str(),
            transcript: String::new(),
            reply: String::new(),
            message: String::new(),
        });
    commands::VoiceAssistantStatus {
        enabled: settings.voice_assistant_enabled,
        wake_word: settings.voice_assistant_wake_word.clone(),
        model_ready,
        stage: last.stage,
        transcript: last.transcript,
        reply: last.reply,
        message: last.message,
        error: STATE
            .error
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone(),
    }
}

/// macOS 麦克风 TCC 授权：CoreAudio 直接打开设备在新系统上不一定触发授权弹窗，
/// 必须显式走 AVCaptureDevice 的授权流程（build.rs 编译 mic_permission.m）。
/// 确保已授权后才返回；被拒绝时报可操作的指引。
#[cfg(target_os = "macos")]
fn ensure_mic_permission(app: &AppHandle) -> Result<(), String> {
    use std::sync::mpsc;
    // AVAuthorizationStatus：0 notDetermined / 1 restricted / 2 denied / 3 authorized。
    extern "C" {
        fn piko_mic_authorization_status() -> i32;
        fn piko_mic_request_access(
            callback: extern "C" fn(i32, *mut std::ffi::c_void),
            context: *mut std::ffi::c_void,
        );
    }
    extern "C" fn on_resolved(granted: i32, context: *mut std::ffi::c_void) {
        let _granted = granted;
        let tx = unsafe { Box::from_raw(context as *mut mpsc::Sender<()>) };
        let _ = tx.send(());
    }
    let denied = || "麦克风权限被拒绝：请在 系统设置→隐私与安全性→麦克风 中允许 Piko".to_string();
    let status = unsafe { piko_mic_authorization_status() };
    eprintln!("[voice-assistant] 麦克风授权状态={status}");
    if status == 3 {
        return Ok(());
    }
    if status == 2 || status == 1 {
        return Err(denied());
    }
    // notDetermined：发起系统授权弹窗并等待用户作答；去系统设置手动开启同样会回调。
    STATE.publish(app, Stage::Idle, "", "", "请在弹窗中允许 Piko 使用麦克风");
    let (tx, rx) = mpsc::channel::<()>();
    let tx = Box::into_raw(Box::new(tx));
    unsafe { piko_mic_request_access(on_resolved, tx as *mut std::ffi::c_void) };
    eprintln!("[voice-assistant] 已发起麦克风授权请求，等待用户作答");
    loop {
        match unsafe { piko_mic_authorization_status() } {
            3 => {
                eprintln!("[voice-assistant] 麦克风授权已允许");
                return Ok(());
            }
            2 | 1 => {
                eprintln!("[voice-assistant] 麦克风授权被拒绝（状态={status}）");
                return Err(denied());
            }
            _ => {
                // 回调或状态轮询任一到达即继续；忽略弹窗时保持低频等待。
                let _ = rx.recv_timeout(Duration::from_secs(2));
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn ensure_mic_permission(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

/// 注册常驻 worker：线程内自管麦克风生命周期，开关关闭时设备完全释放。
pub(crate) fn watch_voice_assistant(app: &AppHandle) {
    let app = app.clone();
    crate::background::SUPERVISOR.spawn("voice-assistant", move |worker| listen_loop(worker, app));
}

fn listen_loop(worker: Worker, app: AppHandle) -> Result<(), String> {
    let mut seen_trigger = 0u64;
    loop {
        if worker.cancelled() {
            return Ok(());
        }
        let settings = crate::settings::read_settings(&app);
        if !settings.voice_assistant_enabled || settings.sensing_paused {
            STATE.publish(&app, Stage::Idle, "", "", "");
            if !worker.wait(Duration::from_secs(1)) {
                return Ok(());
            }
            continue;
        }
        match listening_session(&worker, &app, &settings, &mut seen_trigger) {
            Ok(()) => (), // 设置变化或退出，回到外层重建
            Err(error) => {
                STATE.publish(&app, Stage::Idle, "", "", &error);
                if !worker.wait(Duration::from_secs(3)) {
                    return Ok(());
                }
            }
        }
    }
}

/// 一个启用周期的监听循环：打开麦克风 → 构建 KWS → 检测唤醒 → 触发回合。
/// 返回 Ok 表示应回到外层（设置变化/退出）；Err 表示设备异常，稍后重建。
fn listening_session(
    worker: &Worker,
    app: &AppHandle,
    settings: &crate::app_settings::AppSettings,
    seen_trigger: &mut u64,
) -> Result<(), String> {
    // 先确保麦克风授权（未授权时 macOS 送静音且可能隐藏真实设备），再自动选麦：
    // 绕开虚拟设备，优先最近真实出声的设备；没有真实设备时回落系统默认。
    ensure_mic_permission(app)?;
    mic::log_device_inventory();
    let mut mic = match mic::auto_select_device() {
        Some(name) => mic::open_input(Some(&name)).or_else(|error| {
            eprintln!("[voice-assistant] {error}，回落系统默认输入");
            mic::open_input(None)
        })?,
        None => mic::open_input(None)?,
    };
    eprintln!(
        "[voice-assistant] 麦克风已打开 sample_rate={}",
        mic.sample_rate()
    );
    let mut resampler =
        LinearResampler::create(mic.sample_rate() as i32, 16_000).ok_or("无法创建音频重采样器")?;
    let model = crate::speech::kws_model_definition();
    let mut spotter = None;
    if crate::speech::speech_model_status(app, model).downloaded {
        match kws::Spotter::build(
            &crate::speech::speech_models_dir(app)?.join(model.archive_dir),
            &crate::speech::sense_voice_tokens_path(app, model)?,
            &settings.voice_assistant_wake_tokens,
            &settings.voice_assistant_wake_word,
        ) {
            Ok(built) => {
                spotter = Some(built);
                eprintln!(
                    "[voice-assistant] 唤醒词检测已就绪「{}」({})",
                    settings.voice_assistant_wake_word, settings.voice_assistant_wake_tokens
                );
            }
            Err(error) => {
                eprintln!("[voice-assistant] 唤醒模型构建失败：{error}");
                STATE.publish(app, Stage::Idle, "", "", &error)
            }
        }
    } else {
        eprintln!("[voice-assistant] 唤醒模型未下载");
        STATE.publish(
            app,
            Stage::Idle,
            "",
            "",
            "唤醒模型未下载，请在设置中下载唤醒词检测模型；手动试听不受影响",
        );
    }

    let mut pending: Vec<f32> = Vec::new();
    let mut last_settings_at = Instant::now();
    let mut last_audio_at = Instant::now();
    let mut last_heartbeat_at = Instant::now();
    let mut last_rms = 0.0f32;
    let listening_since = Instant::now();
    let mut silence_hinted = false;
    loop {
        if worker.cancelled() {
            return Ok(());
        }
        let capture = STATE
            .capture
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(CaptureRequest { mode, reply: tx }) =
            capture.filter(|request| !request.reply.is_closed())
        {
            // Audio from the spoken question must never become a user's decision.
            mic.discard_queued();
            pending.clear();
            resampler = LinearResampler::create(mic.sample_rate() as i32, 16_000)
                .ok_or("无法创建音频重采样器")?;
            let (maximum, initial_silence, gate) = match mode {
                CaptureMode::Confirmation => (
                    Duration::from_secs(8),
                    Duration::from_secs(5),
                    UtteranceGate::with_timing(
                        Duration::from_millis(600),
                        Duration::from_millis(100),
                    ),
                ),
                CaptureMode::FollowUp => (
                    Duration::from_secs(32),
                    Duration::from_secs(20),
                    UtteranceGate::new(),
                ),
            };
            let audio = record_audio(
                &mic,
                &mut resampler,
                Vec::new(),
                maximum,
                initial_silence,
                gate,
                || tx.is_closed() || worker.cancelled() || !assistant_enabled(app),
            );
            let _ = tx.send(if assistant_enabled(app) {
                Ok(audio)
            } else {
                Err("语音助手已暂停".into())
            });
            if let Some(spotter) = spotter.as_mut() {
                spotter.reset();
            }
            continue;
        }
        // 手动试听优先，且不依赖唤醒模型。
        if STATE.take_manual_trigger(seen_trigger) && STATE.is_free() {
            eprintln!("[voice-assistant] 手动试听触发");
            run_wake_turn(
                &mut mic,
                &mut resampler,
                app,
                spotter.as_mut(),
                &mut pending,
            );
        }
        if last_settings_at.elapsed() >= Duration::from_secs(1) {
            last_settings_at = Instant::now();
            let current = crate::settings::read_settings(app);
            if !current.voice_assistant_enabled
                || current.sensing_paused
                || current.voice_assistant_wake_word != settings.voice_assistant_wake_word
                || current.voice_assistant_wake_tokens != settings.voice_assistant_wake_tokens
            {
                return Ok(());
            }
            // 自动跟随真实输入设备插拔（虚拟设备除外）。回合中不切换，避免打断
            // 录音/播报；空闲时发现更合适的目标即重建采集（戴上 AirPods 自动用，
            // 摘下自动释放麦克风）。没有真实设备时以系统默认为比较目标，
            // 避免在回落设备上每秒重建。
            if STATE.is_free() {
                let target = mic::auto_select_device().or_else(mic::system_default_input);
                if target.as_deref() != Some(mic.device_name()) {
                    eprintln!(
                        "[voice-assistant] 输入设备切换：{:?} -> {:?}，重建采集",
                        mic.device_name(),
                        target.unwrap_or_default()
                    );
                    return Ok(());
                }
            }
        }
        match mic.recv_timeout(Duration::from_millis(250)) {
            Ok(chunk) => {
                if chunk.is_empty() {
                    return Err("麦克风采集异常，正在重连".into());
                }
                last_audio_at = Instant::now();
                let energy = chunk.iter().map(|s| s * s).sum::<f32>() / chunk.len() as f32;
                last_rms = last_rms * 0.7 + energy.sqrt() * 0.3;
                if last_heartbeat_at.elapsed() >= Duration::from_secs(5) {
                    last_heartbeat_at = Instant::now();
                    eprintln!(
                        "[voice-assistant] 监听中 rms={last_rms:.4} spotter={}",
                        spotter.is_some()
                    );
                    if last_rms > 0.001 {
                        mic::remember_working_device(mic.device_name());
                    }
                    // 长期全零多半是权限未授予或只剩虚拟设备：给出可操作提示（只提示一次）。
                    if !silence_hinted
                        && listening_since.elapsed() >= Duration::from_secs(60)
                        && last_rms < 0.0001
                    {
                        silence_hinted = true;
                        eprintln!(
                            "[voice-assistant] 麦克风持续无有效输入：请检查 系统设置→隐私与安全性→麦克风 是否允许 Piko；连接真实麦克风（AirPods/USB）后会自动切换"
                        );
                    }
                }
                if !STATE.is_free() {
                    pending.clear();
                    continue;
                }
                pending.extend(resampler.resample(&chunk, false));
                while pending.len() >= FEED_BLOCK {
                    let block: Vec<f32> = pending.drain(..FEED_BLOCK).collect();
                    if let Some(spotter) = spotter.as_mut() {
                        if spotter.feed(&block) {
                            eprintln!("[voice-assistant] 检测到唤醒词");
                            if STATE.is_free() {
                                run_wake_turn(
                                    &mut mic,
                                    &mut resampler,
                                    app,
                                    Some(spotter),
                                    &mut pending,
                                );
                            }
                            break;
                        }
                    }
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if last_audio_at.elapsed() > MIC_STALL {
                    return Err("麦克风数据中断，正在重连".into());
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err("麦克风通道关闭，正在重连".into());
            }
        }
    }
}

/// 唤醒：展示状态并唤出面板，录下指令后交给异步回合；随后复位 KWS 继续监听。
fn run_wake_turn(
    mic: &mut mic::MicFeed,
    resampler: &mut LinearResampler,
    app: &AppHandle,
    spotter: Option<&mut kws::Spotter>,
    pending: &mut Vec<f32>,
) {
    STATE.publish(app, Stage::Listening, "", "", "");
    crate::speech::prewarm_voice_recognition(app.clone());
    eprintln!("[voice-assistant] 开始录音");
    let mut seed = std::mem::take(pending);
    let utterance = record_utterance(mic, resampler, &mut seed);
    if let Some(spotter) = spotter {
        spotter.reset();
    }
    eprintln!(
        "[voice-assistant] 录音结束 samples={:.1}s",
        utterance.len() as f32 / 16_000.0
    );
    let turn_app = app.clone();
    crate::background::SUPERVISOR.spawn_async_effect("voice-assistant-turn", move |_| {
        session::run_turn(turn_app, utterance)
    });
}

/// 采集唤醒后的指令语音：能量端点检测（静音 800ms 收尾，最长 12s）。
fn record_utterance(
    mic: &mut mic::MicFeed,
    resampler: &mut LinearResampler,
    seed: &mut Vec<f32>,
) -> Vec<f32> {
    record_audio(
        mic,
        resampler,
        std::mem::take(seed),
        MAX_UTTERANCE,
        Duration::from_millis(1200),
        UtteranceGate::new(),
        || false,
    )
}

fn assistant_enabled(app: &AppHandle) -> bool {
    let settings = crate::settings::read_settings(app);
    settings.voice_assistant_enabled && !settings.sensing_paused
}

fn record_audio(
    mic: &mic::MicFeed,
    resampler: &mut LinearResampler,
    mut buffer: Vec<f32>,
    maximum: Duration,
    initial_silence: Duration,
    mut gate: UtteranceGate,
    cancelled: impl Fn() -> bool,
) -> Vec<f32> {
    let started = Instant::now();
    loop {
        if cancelled()
            || gate.observe(&buffer)
            || started.elapsed() >= maximum
            || (!gate.has_speech() && started.elapsed() >= initial_silence)
        {
            break;
        }
        match mic.recv_timeout(Duration::from_millis(300)) {
            Ok(chunk) => {
                if chunk.is_empty() {
                    break;
                }
                buffer.extend(resampler.resample(&chunk, false));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if buffer.is_empty() && started.elapsed() > MIC_STALL {
                    break;
                }
                gate.observe_silence(Duration::from_millis(300));
            }
            Err(_) => break,
        }
    }
    // Silence should close a follow-up window, not be sent to ASR and hallucinated as words.
    if !gate.has_speech() {
        return Vec::new();
    }
    if let Some(first_speech) = gate.first_speech {
        // Keep a 200ms pre-roll, rather than transcribing up to 20s of waiting silence.
        buffer.drain(..first_speech.saturating_sub(2 * GATE_WINDOW));
        buffer
    } else {
        Vec::new()
    }
}

/// 能量端点检测：自适应噪声底 + 100ms 窗分类，静音满阈值即判定说完。
/// 纯函数（只依赖采样缓冲），便于单元测试。
pub(crate) struct UtteranceGate {
    noise: f32,
    speech_windows: u32,
    trailing_silence_windows: u32,
    processed: usize,
    trailing_silence: Duration,
    min_speech: Duration,
    first_speech: Option<usize>,
}

const SPEECH_ABS_FLOOR: f32 = 0.008;
const NOISE_RATIO: f32 = 3.0;

impl UtteranceGate {
    pub(crate) fn new() -> Self {
        Self::with_timing(TRAILING_SILENCE, MIN_SPEECH)
    }

    fn with_timing(trailing_silence: Duration, min_speech: Duration) -> Self {
        Self {
            noise: 0.002,
            speech_windows: 0,
            trailing_silence_windows: 0,
            processed: 0,
            trailing_silence,
            min_speech,
            first_speech: None,
        }
    }

    fn speech_threshold(&self) -> f32 {
        self.noise * NOISE_RATIO + SPEECH_ABS_FLOOR
    }

    /// 处理缓冲区中尚未分类的完整窗口；返回 true 表示一句话已说完。
    pub(crate) fn observe(&mut self, buffer: &[f32]) -> bool {
        while buffer.len() - self.processed >= GATE_WINDOW {
            let window = &buffer[self.processed..self.processed + GATE_WINDOW];
            self.processed += GATE_WINDOW;
            let energy = window.iter().map(|s| s * s).sum::<f32>() / GATE_WINDOW as f32;
            let rms = energy.sqrt();
            if rms > self.speech_threshold() {
                self.first_speech
                    .get_or_insert(self.processed - GATE_WINDOW);
                self.speech_windows += 1;
                self.trailing_silence_windows = 0;
            } else {
                self.trailing_silence_windows += 1;
                // 噪声底只在静音窗口缓慢跟踪，语音窗口保持稳定。
                self.noise = (self.noise * 0.9 + rms * 0.1).max(0.002);
            }
        }
        self.silence_enough()
    }

    /// 无音频到达的超时推进（设备静默期）。
    pub(crate) fn observe_silence(&mut self, duration: Duration) {
        if self.speech_windows > 0 {
            self.trailing_silence_windows += (duration.as_millis() / 100).min(50) as u32;
        }
    }

    /// 已有足够语音且随后静音满阈值。
    pub(crate) fn silence_enough(&self) -> bool {
        let window_ms = GATE_WINDOW as u32 / 16;
        self.has_speech()
            && self.trailing_silence_windows * window_ms >= self.trailing_silence.as_millis() as u32
    }

    fn has_speech(&self) -> bool {
        self.speech_windows * (GATE_WINDOW as u32 / 16) >= self.min_speech.as_millis() as u32
    }
}

/// 剥掉转写文本开头的唤醒词与紧随的标点；无前缀时原样返回。
pub(crate) fn strip_wake_prefix(transcript: &str, wake_word: &str) -> String {
    const PUNCT: &[char] = &['，', '。', '！', '？', '、', ' ', ',', '.', '!', '?'];
    let text = transcript.trim();
    let wake = wake_word.trim();
    if wake.is_empty() {
        return text.to_string();
    }
    let mut rest = text;
    for expected in wake.chars() {
        rest = rest.trim_start_matches(PUNCT);
        if let Some(tail) = rest.strip_prefix(expected) {
            rest = tail;
        } else {
            return text.to_string();
        }
    }
    rest.trim_start_matches(PUNCT).trim().to_string()
}
