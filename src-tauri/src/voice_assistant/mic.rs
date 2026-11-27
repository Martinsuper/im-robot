//! 麦克风常驻采集：多声道混缩为单声道 f32，由语音助手 worker 线程消费。
//! 回调里只做拷贝入队（满了就丢块），重采样与唤醒检测都在 worker 线程完成。
//! 设备选择绕开 BlackHole 等虚拟设备并跟随真实麦克风的插拔（见 `pick_device`），
//! 不依赖"系统默认输入"——后者会被永远在线的虚拟设备钉死。
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

/// 队列上限：回调端写入失败直接丢弃音频块，绝不阻塞实时回调。
const QUEUE_CAPACITY: usize = 32;

pub(crate) struct MicFeed {
    rx: Receiver<Vec<f32>>,
    sample_rate: u32,
    device_name: String,
    // 保活：Stream 被 drop 即释放设备（macOS 会熄灭麦克风占用指示灯）。
    _stream: cpal::Stream,
}

impl MicFeed {
    pub(crate) fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub(crate) fn device_name(&self) -> &str {
        &self.device_name
    }

    pub(crate) fn recv_timeout(&self, timeout: Duration) -> Result<Vec<f32>, RecvTimeoutError> {
        self.rx.recv_timeout(timeout)
    }

    pub(crate) fn discard_queued(&self) {
        while self.rx.try_recv().is_ok() {}
    }
}

/// 虚拟/回环输入设备标识：它们只在被其他应用显式喂音时才有声音，
/// 自动选麦时必须绕开——否则会挡住真实麦克风的自动切换。
fn is_virtual_device(name: &str) -> bool {
    let name = name.to_lowercase();
    [
        "blackhole",
        "loopback",
        "soundflower",
        "vb-cable",
        "aggregate",
        "multi-output",
        "virtual",
    ]
    .iter()
    .any(|marker| name.contains(marker))
}

/// 会话内记住最近真实出声的输入设备：设备优先级缺失时用它避免在多个
/// 真实设备之间抖动（如同时插着 USB 麦与戴着 AirPods）。
static LAST_GOOD_DEVICE: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

pub(crate) fn remember_working_device(name: &str) {
    *LAST_GOOD_DEVICE.lock().unwrap_or_else(|e| e.into_inner()) = Some(name.to_string());
}

/// 在给定的候选设备名中选出自动模式的目标：最近出声的 > 第一个真实设备。
/// 纯函数便于单测；候选为空（只剩虚拟设备）返回 None，由调用方回落系统默认。
pub(crate) fn pick_device<'a>(names: &[&'a str], last_good: Option<&'a str>) -> Option<&'a str> {
    let real: Vec<&str> = names
        .iter()
        .copied()
        .filter(|name| !is_virtual_device(name))
        .collect();
    if let Some(last_good) = last_good {
        if real.contains(&last_good) {
            return Some(last_good);
        }
    }
    real.first().copied()
}

/// 枚举当前所有输入设备名。
fn list_input_devices() -> Vec<String> {
    let devices: Vec<String> = cpal::default_host()
        .input_devices()
        .into_iter()
        .flatten()
        .filter_map(|device| device.name().ok())
        .collect();
    devices
}

/// 枚举设备全景（诊断用）：进程看到的设备与系统设置不一致时（如 TCC 把
/// 真实麦克风藏掉），这条日志能立刻对出差异。
pub(crate) fn log_device_inventory() {
    let devices = list_input_devices();
    let default = system_default_input().unwrap_or_default();
    eprintln!("[voice-assistant] 可用输入设备 {devices:?}（系统默认：{default:?}）");
}

/// 自动模式当前应使用的输入设备名；None 表示没有真实麦克风可用。
pub(crate) fn auto_select_device() -> Option<String> {
    let names = list_input_devices();
    let last_good = LAST_GOOD_DEVICE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    pick_device(
        &names.iter().map(String::as_str).collect::<Vec<_>>(),
        last_good.as_deref(),
    )
    .map(str::to_owned)
}

/// 系统默认输入设备名（自动选择的最终回落，见 listening_session）。
pub(crate) fn system_default_input() -> Option<String> {
    cpal::default_host()
        .default_input_device()
        .and_then(|device| device.name().ok())
}

/// 打开指定输入设备；`preferred` 为 None 时回落系统默认。
/// 每次启用周期重建；设备失联由 worker 关闭后重试。
pub(crate) fn open_input(preferred: Option<&str>) -> Result<MicFeed, String> {
    let host = cpal::default_host();
    let device = match preferred {
        Some(name) => host
            .input_devices()
            .map_err(|e| format!("无法枚举输入设备：{e}"))?
            .find(|device| device.name().ok().as_deref() == Some(name))
            .ok_or_else(|| format!("输入设备 {name} 当前不可用"))?,
        None => host
            .default_input_device()
            .ok_or_else(|| "未找到可用的麦克风设备".to_string())?,
    };
    let device_name = device.name().unwrap_or_default();
    eprintln!("[voice-assistant] 输入设备: {device_name}");
    let supported = device
        .default_input_config()
        .map_err(|e| format!("无法读取麦克风配置：{e}"))?;
    let config: cpal::StreamConfig = supported.clone().into();
    let sample_rate = config.sample_rate.0;
    let channels = usize::from(config.channels.max(1));
    let (tx, rx): (SyncSender<Vec<f32>>, Receiver<Vec<f32>>) = sync_channel(QUEUE_CAPACITY);
    let error_tx = tx.clone();

    let error_handler = move |error| {
        // 采集错误不 panic：worker 通过数据断流超时感知设备失联并重建。
        let _ = error_tx.try_send(Vec::new());
        eprintln!("[voice-assistant] mic stream error: {error}");
    };

    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config,
            mono_forward(channels, move |frame| frame, tx),
            error_handler,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config,
            mono_forward(channels, |frame: i16| frame as f32 / 32768.0, tx),
            error_handler,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config,
            mono_forward(
                channels,
                |frame: u16| frame as f32 / u16::MAX as f32 * 2.0 - 1.0,
                tx,
            ),
            error_handler,
            None,
        ),
        _ => return Err("麦克风采样格式不受支持，请更换输入设备".into()),
    }
    .map_err(|e| format!("无法打开麦克风采集：{e}"))?;
    stream
        .play()
        .map_err(|e| format!("无法启动麦克风采集：{e}"))?;
    Ok(MicFeed {
        rx,
        sample_rate,
        device_name,
        _stream: stream,
    })
}

/// 生成把交错多声道回调数据混缩为单声道并入队的闭包。空块是失联信号，同样入队。
fn mono_forward<T, F>(
    channels: usize,
    to_f32: F,
    tx: SyncSender<Vec<f32>>,
) -> impl FnMut(&[T], &cpal::InputCallbackInfo) + Send + 'static
where
    T: cpal::SizedSample + Copy + Send + 'static,
    F: Fn(T) -> f32 + Send + 'static,
{
    move |data: &[T], _: &cpal::InputCallbackInfo| {
        if data.is_empty() {
            return;
        }
        let frames = data.len() / channels.max(1);
        let mut mono = Vec::with_capacity(frames);
        for frame in 0..frames {
            let mut sum = 0.0f32;
            for channel in 0..channels {
                sum += to_f32(data[frame * channels + channel]);
            }
            mono.push(sum / channels as f32);
        }
        let _ = tx.try_send(mono);
    }
}
