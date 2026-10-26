//! Bounded SSE decoder and continuous 24 kHz -> 16 kHz PCM resampling.
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use serde_json::Value;
use std::time::Duration;
use tauri::AppHandle;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const MAX_WIRE: usize = 4 * 1024 * 1024;
const MAX_EVENT: usize = 256 * 1024;
const MAX_PCM: usize = 24_000 * 2 * 40;
pub(crate) const CHUNK: usize = 2048;

#[derive(Default)]
struct Resampler {
    byte: Option<u8>,
    samples: Vec<i16>,
}
impl Resampler {
    fn push(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut output = Vec::with_capacity(bytes.len() * 2 / 3 + 4);
        for &byte in bytes {
            if let Some(lo) = self.byte.take() {
                self.samples.push(i16::from_le_bytes([lo, byte]));
                if self.samples.len() == 3 {
                    output.extend_from_slice(&self.samples[0].to_le_bytes());
                    let value =
                        ((i32::from(self.samples[1]) + i32::from(self.samples[2])) / 2) as i16;
                    output.extend_from_slice(&value.to_le_bytes());
                    self.samples.clear();
                }
            } else {
                self.byte = Some(byte);
            }
        }
        output
    }
    fn finish(&mut self) -> Result<Vec<u8>, String> {
        if self.byte.is_some() {
            return Err("MiMo 音频数据不完整，请重试".into());
        }
        Ok(self.samples.drain(..).flat_map(i16::to_le_bytes).collect())
    }
}
#[derive(Default)]
struct Decoder {
    line: Vec<u8>,
    event: Vec<u8>,
    wire: usize,
    pcm: usize,
    done: bool,
    resampler: Resampler,
}
impl Decoder {
    fn event(&mut self) -> Result<Vec<u8>, String> {
        if self.event.is_empty() {
            return Ok(Vec::new());
        }
        let bytes = std::mem::take(&mut self.event);
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| "MiMo 流式数据格式错误")?
            .trim();
        if text == "[DONE]" {
            self.done = true;
            return Ok(Vec::new());
        }
        if self.done {
            return Err("MiMo 在语音结束后仍返回数据".into());
        }
        let value: Value = serde_json::from_str(text).map_err(|_| "MiMo 流式数据格式错误")?;
        if value.get("error").is_some() {
            return Err("MiMo 流式语音生成失败，请重试".into());
        }
        let Some(data) = value
            .pointer("/choices/0/delta/audio/data")
            .and_then(Value::as_str)
        else {
            return Ok(Vec::new());
        };
        let raw = STANDARD.decode(data).map_err(|_| "MiMo 流式音频格式错误")?;
        self.pcm += raw.len();
        if self.pcm > MAX_PCM {
            return Err("回复语音超过40秒，请分段朗读".into());
        }
        Ok(self.resampler.push(&raw))
    }
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<Vec<u8>>, String> {
        self.wire += chunk.len();
        if self.wire > MAX_WIRE {
            return Err("MiMo 流式响应过长".into());
        }
        let mut audio = Vec::new();
        for &byte in chunk {
            if byte == b'\n' {
                if self.line.last() == Some(&b'\r') {
                    self.line.pop();
                }
                if self.line.is_empty() {
                    let pcm = self.event()?;
                    if !pcm.is_empty() {
                        audio.push(pcm);
                    }
                } else if self.line.starts_with(b"data:") {
                    let mut data = &self.line[5..];
                    if data.first() == Some(&b' ') {
                        data = &data[1..];
                    }
                    if self.event.len() + data.len() + 1 > MAX_EVENT {
                        return Err("MiMo 流式消息过长".into());
                    }
                    self.event.extend_from_slice(data);
                    self.event.push(b'\n');
                }
                self.line.clear();
            } else {
                if self.line.len() >= MAX_EVENT {
                    return Err("MiMo 流式消息过长".into());
                }
                self.line.push(byte);
            }
        }
        Ok(audio)
    }
    fn finish(&mut self) -> Result<Vec<u8>, String> {
        if !self.done || self.pcm == 0 || !self.line.is_empty() || !self.event.is_empty() {
            return Err("MiMo 语音传输中断，请重试".into());
        }
        self.resampler.finish()
    }
}
async fn send(tx: &mpsc::Sender<Vec<u8>>, pcm: Vec<u8>) -> Result<(), String> {
    for chunk in pcm.chunks(CHUNK) {
        tx.send(chunk.to_vec())
            .await
            .map_err(|_| "语音播放已取消")?;
    }
    Ok(())
}
async fn fetch(
    endpoint: &str,
    key: &str,
    settings: &crate::tts::SpeechOutputSettings,
    text: &str,
    tx: mpsc::Sender<Vec<u8>>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|_| "无法初始化语音服务")?;
    let mut body = crate::tts::request_body(settings, text);
    body["stream"] = Value::Bool(true);
    body["audio"]["format"] = Value::String("pcm16".into());
    let response = client
        .post(endpoint)
        .header("api-key", key)
        .json(&body)
        .send()
        .await
        .map_err(|_| "无法连接 MiMo 语音服务")?;
    match response.status().as_u16() {
        200..=299 => {}
        401 | 403 => return Err("MiMo API Key 无效或没有语音模型权限".into()),
        402 => return Err("MiMo 账户额度不足".into()),
        429 => return Err("MiMo 请求过于频繁或额度已用完".into()),
        _ => return Err("MiMo 语音服务暂不可用".into()),
    }
    if !response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/event-stream"))
    {
        return Err("MiMo 未返回流式音频，请检查模型权限".into());
    }
    let mut decoder = Decoder::default();
    let mut stream = response.bytes_stream();
    while let Some(bytes) = stream.next().await {
        let bytes = bytes.map_err(|_| "MiMo 语音传输中断，请重试")?;
        for pcm in decoder.push(&bytes)? {
            send(&tx, pcm).await?;
        }
        if decoder.done {
            break;
        }
    }
    send(&tx, decoder.finish()?).await
}
pub(crate) async fn synthesize(
    app: &AppHandle,
    text: &str,
    tx: mpsc::Sender<Vec<u8>>,
) -> Result<(), String> {
    let settings = crate::tts::settings(app)?;
    let key = tokio::task::spawn_blocking(crate::credentials::read_mimo_tts_key)
        .await
        .map_err(|_| "无法读取 MiMo 凭据")??
        .ok_or("请先填写 MiMo API Key")?;
    let text = crate::speech::text_for_speech(text);
    if text.trim().is_empty() || text.chars().count() > 2000 {
        return Err("没有可朗读内容或内容过长，请分段朗读".into());
    }
    fetch(crate::tts::ENDPOINT, &key, &settings, &text, tx).await
}

fn playback(rx: mpsc::Receiver<Vec<u8>>, cancel: CancellationToken) -> Result<(), String> {
    playback_ready(rx, cancel, None)
}
fn playback_ready(
    mut rx: mpsc::Receiver<Vec<u8>>,
    cancel: CancellationToken,
    mut ready: Option<tokio::sync::oneshot::Sender<()>>,
) -> Result<(), String> {
    if cancel.is_cancelled() {
        return Err("已取消朗读".into());
    }
    let mut output =
        rodio::OutputStreamBuilder::open_default_stream().map_err(|_| "无法打开音频输出设备")?;
    output.log_on_drop(false);
    let sink = rodio::Sink::connect_new(output.mixer());
    while let Some(pcm) = rx.blocking_recv() {
        if cancel.is_cancelled() {
            sink.stop();
            return Err("已取消朗读".into());
        }
        while sink.len() >= 4 {
            if cancel.is_cancelled() {
                sink.stop();
                return Err("已取消朗读".into());
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let samples: Vec<f32> = pcm
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| i16::from_le_bytes(*b) as f32 / 32768.0)
            .collect();
        sink.append(rodio::buffer::SamplesBuffer::new(1, 16000, samples));
        if let Some(ready) = ready.take() {
            let _ = ready.send(());
        }
    }
    while !sink.empty() {
        if cancel.is_cancelled() {
            sink.stop();
            return Err("已取消朗读".into());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}
pub(crate) async fn speak(
    app: &AppHandle,
    text: &str,
    cancel: CancellationToken,
) -> Result<(), String> {
    let (tx, rx) = mpsc::channel(4);
    let play_cancel = cancel.clone();
    let job = tokio::task::spawn_blocking(move || playback(rx, play_cancel));
    let generated = tokio::select! {_=cancel.cancelled()=>Err("已取消朗读".into()),value=synthesize(app,text,tx)=>value};
    if generated.is_err() {
        cancel.cancel();
    }
    let played = job.await.map_err(|_| "音频播放任务失败")?;
    generated.and(played)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };
    fn frame(raw: &[u8]) -> Vec<u8> {
        format!(
            "data: {}\r\n\r\n",
            serde_json::json!({"choices":[{"delta":{"audio":{"data":STANDARD.encode(raw)}}}]})
        )
        .into_bytes()
    }
    #[test]
    fn arbitrary_network_and_sample_boundaries_preserve_continuous_pcm() {
        let raw: Vec<u8> = (0..1501i16).flat_map(i16::to_le_bytes).collect();
        let mut body = b": keepalive\r\n\r\n".to_vec();
        for bytes in raw.chunks(127) {
            body.extend(frame(bytes));
        }
        body.extend(b"data: [DONE]\r\n\r\n");
        let mut resampler = Resampler::default();
        let mut expected = resampler.push(&raw);
        expected.extend(resampler.finish().unwrap());
        assert_eq!(&expected[..8], &[0, 0, 1, 0, 3, 0, 4, 0]);
        for size in [1, 2, 5, 7, 31, 4096] {
            let mut decoder = Decoder::default();
            let mut output = Vec::new();
            for chunk in body.chunks(size) {
                for pcm in decoder.push(chunk).unwrap() {
                    output.extend(pcm);
                }
            }
            output.extend(decoder.finish().unwrap());
            assert_eq!(output, expected, "network size {size}");
        }
    }
    #[test]
    fn truncated_oversized_and_provider_error_streams_are_not_success() {
        let mut decoder = Decoder::default();
        decoder.push(&frame(&[0; 16])).unwrap();
        assert!(decoder.finish().is_err());
        let mut decoder = Decoder::default();
        decoder.push(&frame(&[0; 3])).unwrap();
        decoder.push(b"data: [DONE]\n\n").unwrap();
        assert!(decoder.finish().is_err());
        let mut decoder = Decoder::default();
        assert!(decoder.push(&vec![b'x'; MAX_EVENT + 1]).is_err());
        let mut decoder = Decoder::default();
        let error = decoder
            .push(b"data: {\"error\":\"private-key\"}\n\n")
            .unwrap_err();
        assert!(!error.contains("private-key"));
        let mut decoder = Decoder::default();
        for _ in 0..40 {
            decoder.push(&frame(&vec![0; 48000])).unwrap();
        }
        assert!(decoder.push(&frame(&[0, 0])).is_err());
    }
    #[tokio::test]
    async fn first_pcm_arrives_while_http_generation_is_still_open() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let (release, wait) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut buf = [0; 2048];
            let end = loop {
                let n = socket.read(&mut buf).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&buf[..n]);
                if let Some(n) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
                    break n + 4;
                }
            };
            let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
            let len: usize = headers
                .lines()
                .find_map(|s| s.strip_prefix("content-length:"))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            while bytes.len() < end + len {
                let n = socket.read(&mut buf).unwrap();
                bytes.extend_from_slice(&buf[..n]);
            }
            let request: Value = serde_json::from_slice(&bytes[end..end + len]).unwrap();
            assert_eq!(request["stream"], true);
            assert_eq!(request["audio"]["format"], "pcm16");
            assert_eq!(request["messages"][1]["role"], "assistant");
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").unwrap();
            socket.write_all(&frame(&vec![0; 960])).unwrap();
            socket.flush().unwrap();
            wait.recv_timeout(Duration::from_secs(3))
                .expect("first audio must be delivered before finishing generation");
            socket.write_all(b"data: [DONE]\n\n").unwrap();
        });
        let (tx, mut rx) = mpsc::channel(1);
        let worker = tokio::spawn(async move {
            fetch(
                &endpoint,
                "test-key",
                &crate::tts::SpeechOutputSettings::default(),
                "你好",
                tx,
            )
            .await
        });
        let first = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.len(), 640);
        release.send(()).unwrap();
        while rx.recv().await.is_some() {}
        worker.await.unwrap().unwrap();
        server.join().unwrap();
    }
    #[tokio::test]
    async fn bounded_receiver_applies_backpressure_and_cancellation() {
        let (tx, mut rx) = mpsc::channel(1);
        let job = tokio::spawn(async move { send(&tx, vec![0; CHUNK * 3]).await });
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(!job.is_finished());
        assert_eq!(rx.recv().await.unwrap().len(), CHUNK);
        drop(rx);
        assert!(job.await.unwrap().is_err());
    }
    #[tokio::test]
    #[ignore = "requires a local audio output device; generates only silence"]
    async fn native_stream_playback_and_cancel() {
        let (tx, rx) = mpsc::channel(4);
        let cancel = CancellationToken::new();
        let playback_cancel = cancel.clone();
        let (started, ready) = tokio::sync::oneshot::channel();
        let job =
            tokio::task::spawn_blocking(move || playback_ready(rx, playback_cancel, Some(started)));
        for _ in 0..4 {
            tx.send(vec![0; CHUNK]).await.unwrap();
        }
        tokio::time::timeout(Duration::from_secs(10), ready)
            .await
            .unwrap()
            .unwrap();
        cancel.cancel();
        drop(tx);
        assert!(tokio::time::timeout(Duration::from_secs(3), job)
            .await
            .unwrap()
            .unwrap()
            .is_err());
    }
    #[tokio::test]
    #[ignore = "requires the user's configured MiMo key and makes a real TTS request"]
    async fn real_mimo_stream_first_audio() {
        assert_eq!(std::env::var("PIKO_REAL_MIMO_TTS_TEST").as_deref(), Ok("1"));
        let key = std::env::var("PIKO_MIMO_TTS_TEST_KEY")
            .expect("set a dedicated test API key in the environment");
        let config = std::path::PathBuf::from(std::env::var("PIKO_TTS_SETTINGS_PATH").unwrap());
        let settings: crate::tts::SpeechOutputSettings =
            serde_json::from_slice(&std::fs::read(config).unwrap()).unwrap();
        let (tx, mut rx) = mpsc::channel(4);
        let started = std::time::Instant::now();
        let worker = tokio::spawn(async move {
            fetch(
                crate::tts::ENDPOINT,
                &key,
                &settings,
                "你好，我是 Piko。现在可以边生成边播放了。",
                tx,
            )
            .await
        });
        let mut first = None;
        let mut audio = Vec::new();
        while let Some(pcm) = rx.recv().await {
            if first.is_none() {
                first = Some(started.elapsed());
            }
            audio.extend(pcm);
        }
        worker.await.unwrap().unwrap();
        assert!(!audio.is_empty());
        let output = std::path::PathBuf::from(std::env::var("PIKO_TTS_SMOKE_OUTPUT").unwrap());
        std::fs::write(output, crate::device_voice::pcm_wav(&audio)).unwrap();
        println!(
            "Real MiMo: first PCM {:.3}s, generation finished {:.3}s, audio {:.3}s",
            first.unwrap().as_secs_f64(),
            started.elapsed().as_secs_f64(),
            audio.len() as f64 / 32000.0
        );
    }
}
