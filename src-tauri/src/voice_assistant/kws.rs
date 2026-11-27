//! 本地唤醒词检测（sherpa-onnx KeywordSpotter）。
//! keywords 行格式（与模型自带 keywords.txt 一致）：
//!   `声调符号拼音 token 序列 @中文显示文本`，如 `n ǐ h ǎo p í k ě @你好皮可`。
use std::collections::HashSet;
use std::path::PathBuf;

use sherpa_onnx::{
    KeywordSpotter as SherpaSpotter, KeywordSpotterConfig, OnlineStream,
    OnlineTransducerModelConfig,
};

/// 命中概率阈值；sherpa-onnx 默认 0.25，实测误唤醒可接受。
const KEYWORDS_THRESHOLD: f32 = 0.25;
/// KWS 解码线程数：常驻场景追求低占用，单线程足够。
const NUM_THREADS: i32 = 1;

/// 把用户配置的拼音 token 序列与唤醒词文本拼成 keywords.txt 行。
/// 非法 token（tokens.txt 中不存在）直接报错，避免唤醒词静默失效。
pub(crate) fn keywords_line(
    wake_tokens: &str,
    wake_word: &str,
    known_tokens: &HashSet<String>,
) -> Result<String, String> {
    let tokens = wake_tokens.split_whitespace().collect::<Vec<_>>();
    if tokens.is_empty() {
        return Err("唤醒词拼音 token 不能为空".into());
    }
    let missing: Vec<&str> = tokens
        .iter()
        .filter(|token| !known_tokens.contains(**token))
        .copied()
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "唤醒词拼音 token 不合法：{}；请使用模型 tokens.txt 中的声调符号拼音",
            missing.join(" ")
        ));
    }
    let display = wake_word.trim();
    if display.is_empty() || display.contains(['\n', '\r', '@']) {
        return Err("唤醒词文本不能为空且不能包含换行或 @".into());
    }
    Ok(format!("{wake_tokens} @{display}"))
}

/// 校验 + 组装 keywords 内容（供单测与 Spotter 构建共用）。
pub(crate) fn build_keywords_content(
    wake_tokens: &str,
    wake_word: &str,
    tokens_file: &str,
) -> Result<String, String> {
    let known: HashSet<String> = tokens_file
        .lines()
        .filter_map(|line| line.split_whitespace().next())
        .map(str::to_owned)
        .collect();
    let line = keywords_line(wake_tokens, wake_word, &known)?;
    Ok(format!("{line}\n"))
}

pub(crate) struct Spotter {
    inner: SherpaSpotter,
    stream: OnlineStream,
}

impl Spotter {
    /// 用下载好的 KWS 模型与用户配置的唤醒词构建检测器。
    pub(crate) fn build(
        model_dir: &PathBuf,
        tokens_path: &PathBuf,
        wake_tokens: &str,
        wake_word: &str,
    ) -> Result<Spotter, String> {
        let tokens_file = std::fs::read_to_string(tokens_path)
            .map_err(|e| format!("唤醒模型 tokens.txt 读取失败：{e}"))?;
        let keywords = build_keywords_content(wake_tokens, wake_word, &tokens_file)?;
        let encoder = find_model_file(model_dir, "encoder")?;
        let decoder = find_model_file(model_dir, "decoder")?;
        let joiner = find_model_file(model_dir, "joiner")?;

        let mut config = KeywordSpotterConfig::default();
        config.model_config.transducer = OnlineTransducerModelConfig {
            encoder: Some(encoder.to_string_lossy().into_owned()),
            decoder: Some(decoder.to_string_lossy().into_owned()),
            joiner: Some(joiner.to_string_lossy().into_owned()),
        };
        config.model_config.tokens = Some(tokens_path.to_string_lossy().into_owned());
        config.model_config.num_threads = NUM_THREADS;
        config.model_config.provider = Some("cpu".to_string());
        config.keywords_threshold = KEYWORDS_THRESHOLD;
        config.keywords_buf = Some(keywords);

        let inner = SherpaSpotter::create(&config)
            .ok_or_else(|| "唤醒模型加载失败，请重新下载".to_string())?;
        let stream = inner.create_stream();
        Ok(Spotter { inner, stream })
    }

    /// 喂入 16kHz 单声道音频；返回 true 表示检测到唤醒词（内部已复位流）。
    pub(crate) fn feed(&mut self, samples: &[f32]) -> bool {
        if samples.is_empty() {
            return false;
        }
        self.stream.accept_waveform(16_000, samples);
        let mut wake = false;
        while self.inner.is_ready(&self.stream) {
            self.inner.decode(&self.stream);
            if let Some(result) = self.inner.get_result(&self.stream) {
                if !result.keyword.trim().is_empty() {
                    wake = true;
                }
            }
        }
        if wake {
            self.reset();
        }
        wake
    }

    /// 复位检测状态：唤醒回合结束后调用，避免旧状态污染。
    pub(crate) fn reset(&mut self) {
        self.inner.reset(&self.stream);
    }
}

/// 在模型目录中定位 encoder/decoder/joiner onnx 文件（int8 优先）。
/// 归档同时包含 epoch-12/epoch-99 与 int8/fp32 变体，按前缀 + int8 优先匹配。
fn find_model_file(model_dir: &PathBuf, component: &str) -> Result<PathBuf, String> {
    let mut matches: Vec<PathBuf> = std::fs::read_dir(model_dir)
        .map_err(|e| format!("唤醒模型目录读取失败：{e}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            name.starts_with(component) && name.ends_with(".onnx")
        })
        .collect();
    matches.sort_by_key(|path| {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        // int8 优先（体积小、CPU 推理快），其次任取字典序最小保证确定性。
        (
            if name.contains(".int8.onnx") { 0 } else { 1 },
            name.to_string(),
        )
    });
    matches
        .into_iter()
        .next()
        .ok_or_else(|| format!("唤醒模型缺少 {component} onnx 文件，请删除后重新下载"))
}
