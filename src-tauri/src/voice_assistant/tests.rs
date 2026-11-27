//! 纯函数单元测试：唤醒词 keywords 生成、转写前缀剥离、能量端点检测。
use super::*;

const TOKENS_FILE: &str = "n 1\nǐ 2\nh 3\nǎo 4\np 5\ní 6\nk 7\ně 8\nāi 9\n";

#[test]
fn keywords_line_maps_tokens_to_display_text() {
    let content = kws::build_keywords_content("n ǐ h ǎo p í k ě", "你好皮可", TOKENS_FILE).unwrap();
    assert_eq!(content, "n ǐ h ǎo p í k ě @你好皮可\n");
}

#[test]
fn keywords_reject_unknown_tokens_and_bad_display() {
    assert!(kws::build_keywords_content("x üe sh eng", "学生", TOKENS_FILE).is_err());
    assert!(kws::build_keywords_content("", "你好皮可", TOKENS_FILE).is_err());
    assert!(kws::build_keywords_content("n ǐ", "", TOKENS_FILE).is_err());
    assert!(kws::build_keywords_content("n ǐ", "你好@皮可", TOKENS_FILE).is_err());
    assert!(kws::build_keywords_content("n ǐ", "你好\n皮可", TOKENS_FILE).is_err());
}

#[test]
fn wake_prefix_is_stripped_with_punctuation_boundaries() {
    assert_eq!(strip_wake_prefix("你好，皮可。", "你好皮可"), "");
    assert_eq!(strip_wake_prefix("你好，皮可，确认", "你好皮可"), "确认");
    assert_eq!(
        strip_wake_prefix("你好皮可，现在几点", "你好皮可"),
        "现在几点"
    );
    assert_eq!(
        strip_wake_prefix("你好皮可现在几点", "你好皮可"),
        "现在几点"
    );
    assert_eq!(strip_wake_prefix("你好皮可！", "你好皮可"), "");
    assert_eq!(
        strip_wake_prefix("，你好皮可帮我建个提醒", "你好皮可"),
        "帮我建个提醒"
    );
    // 无唤醒词前缀时原样保留，交由 Agent 理解。
    assert_eq!(strip_wake_prefix("现在几点", "你好皮可"), "现在几点");
    assert_eq!(strip_wake_prefix("", "你好皮可"), "");
    // 唤醒词为空时不应剥掉任何内容。
    assert_eq!(
        strip_wake_prefix("你好皮可，现在几点", ""),
        "你好皮可，现在几点"
    );
}

/// 生成 count 个 100ms（1600 样本）的恒值窗口。
fn window(value: f32, count: usize) -> Vec<f32> {
    vec![value; count * 1_600]
}

#[test]
fn utterance_gate_ends_after_speech_and_trailing_silence() {
    let mut gate = UtteranceGate::new();
    let mut buffer = window(0.001, 3);
    assert!(!gate.observe(&buffer), "纯静音不应触发收尾");
    buffer.extend(window(0.2, 3));
    assert!(!gate.observe(&buffer), "语音刚结束还不应收尾");
    buffer.extend(window(0.001, 16));
    assert!(gate.observe(&buffer), "足够语音 + 1.6s 静音应收尾");
}

#[test]
fn utterance_gate_requires_minimum_speech() {
    let mut gate = UtteranceGate::new();
    let mut buffer = window(0.001, 2);
    buffer.extend(window(0.2, 1)); // 仅 100ms 语音
    buffer.extend(window(0.001, 20));
    assert!(
        !gate.observe(&buffer),
        "语音不足 200ms 不应收尾，继续等指令"
    );
    assert!(!gate.has_speech(), "短脉冲不能把唤醒后的等待延长到录音上限");
}

#[test]
fn short_confirmation_at_the_start_is_not_mistaken_for_background_noise() {
    let mut gate =
        UtteranceGate::with_timing(Duration::from_millis(600), Duration::from_millis(100));
    let mut audio = window(0.2, 1);
    audio.extend(window(0.001, 5));
    assert!(!gate.observe(&audio));
    audio.extend(window(0.001, 1));
    assert!(gate.observe(&audio));
}

#[test]
fn normal_recording_ends_after_800ms_of_silence_without_waiting_the_old_1500ms() {
    let mut gate = UtteranceGate::new();
    let mut audio = window(0.2, 3);
    audio.extend(window(0.001, 7));
    assert!(!gate.observe(&audio));
    audio.extend(window(0.001, 1));
    assert!(gate.observe(&audio));
}

#[test]
fn followup_waiting_silence_is_distinct_from_the_start_of_user_speech() {
    let mut gate = UtteranceGate::new();
    let mut audio = window(0.001, 100);
    assert!(!gate.observe(&audio));
    assert!(gate.first_speech.is_none());
    audio.extend(window(0.2, 3));
    audio.extend(window(0.001, 8));
    assert!(gate.observe(&audio));
    assert_eq!(gate.first_speech, Some(100 * GATE_WINDOW));
}

#[test]
fn abandoned_capture_requests_cannot_supply_a_later_confirmation() {
    let state = Shared::default();
    let abandoned = state.request_capture(CaptureMode::Confirmation);
    drop(abandoned);
    assert!(state
        .capture
        .lock()
        .unwrap()
        .take()
        .unwrap()
        .reply
        .is_closed());
    let mut fresh = state.request_capture(CaptureMode::FollowUp);
    state
        .capture
        .lock()
        .unwrap()
        .take()
        .unwrap()
        .reply
        .send(Ok(vec![0.2]))
        .unwrap();
    assert_eq!(fresh.try_recv().unwrap().unwrap(), vec![0.2]);
}

#[test]
fn utterance_gate_tracks_silence_timeouts_only_after_speech() {
    let mut gate = UtteranceGate::new();
    let mut buffer = window(0.001, 2);
    buffer.extend(window(0.2, 3));
    assert!(!gate.observe(&buffer), "语音刚结束还没静音，不应收尾");
    // 没有新音频到达（设备静默）：静音超时推进可完成收尾判定。
    for _ in 0..5 {
        gate.observe_silence(std::time::Duration::from_millis(300));
    }
    assert!(gate.silence_enough(), "5×300ms 静音应补足 1.5s 收尾");
    // 语音尚未开始时超时不应累计。
    let mut fresh = UtteranceGate::new();
    fresh.observe_silence(std::time::Duration::from_secs(60));
    assert!(!fresh.silence_enough());
}

#[test]
fn loud_background_noise_does_not_confuse_adaptive_floor() {
    let mut gate = UtteranceGate::new();
    let mut buffer = window(0.01, 4); // 稳定底噪
    buffer.extend(window(0.5, 4)); // 语音远高于噪声底
    assert!(!gate.observe(&buffer));
    buffer.extend(window(0.01, 16));
    assert!(gate.observe(&buffer));
}

#[test]
fn device_selection_skips_virtual_and_prefers_last_good() {
    // 虚拟设备（BlackHole 等）永远在线，绝不能被自动选中。
    assert_eq!(
        mic::pick_device(&["BlackHole 2ch", "AirPods Pro"], None),
        Some("AirPods Pro")
    );
    assert_eq!(mic::pick_device(&["BlackHole 2ch"], None), None);
    // 最近真实出声的设备优先于枚举顺序，避免多设备间抖动。
    assert_eq!(
        mic::pick_device(&["USB Microphone", "AirPods Pro"], Some("AirPods Pro")),
        Some("AirPods Pro")
    );
    // 最近出声的设备消失后回落到剩余真实设备。
    assert_eq!(
        mic::pick_device(&["BlackHole 2ch", "USB Microphone"], Some("AirPods Pro")),
        Some("USB Microphone")
    );
    assert_eq!(mic::pick_device(&[], Some("AirPods Pro")), None);
}
