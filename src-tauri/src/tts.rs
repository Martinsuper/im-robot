//! MiMo speech output. Keys stay in the OS credential store, away from devices.
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};
use tauri::{AppHandle, Manager};

pub(crate) const ENDPOINT: &str = "https://api.xiaomimimo.com/v1/chat/completions";
const MAX_RESPONSE: usize = 4 * 1024 * 1024;
const VOICES: &[&str] = &[
    "mimo_default",
    "冰糖",
    "茉莉",
    "苏打",
    "白桦",
    "Mia",
    "Chloe",
    "Milo",
    "Dean",
];

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct SpeechOutputSettings {
    pub provider: String,
    pub voice: String,
    pub style: String,
}
impl Default for SpeechOutputSettings {
    fn default() -> Self {
        Self { provider:"system".into(), voice:"冰糖".into(), style:"用自然、温暖的普通话交流，像在和熟悉的朋友聊天。语速适中，停顿自然，避免播音腔和夸张表演。".into() }
    }
}
// Status is a separate wire type: secret availability is never persisted.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechOutputStatus {
    pub provider: String,
    pub voice: String,
    pub style: String,
    pub has_api_key: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechOutputInput {
    pub provider: String,
    pub voice: String,
    pub style: String,
    pub api_key: Option<String>,
}
fn path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|_| "无法获取语音设置目录")?
        .join("speech-output.json"))
}
pub(crate) fn settings(app: &AppHandle) -> Result<SpeechOutputSettings, String> {
    let value: SpeechOutputSettings = crate::storage::read(&path(app)?)?;
    validate(&value)?;
    Ok(value)
}
fn validate(s: &SpeechOutputSettings) -> Result<(), String> {
    if !["system", "mimo"].contains(&s.provider.as_str()) {
        return Err("不支持的语音服务".into());
    }
    if !VOICES.contains(&s.voice.as_str()) {
        return Err("请选择有效的 MiMo 音色".into());
    }
    if s.style.chars().count() > 500 {
        return Err("语气描述最多500字".into());
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn get_speech_output_settings(app: AppHandle) -> Result<SpeechOutputStatus, String> {
    let s = settings(&app)?;
    Ok(SpeechOutputStatus {
        provider: s.provider,
        voice: s.voice,
        style: s.style,
        has_api_key: crate::credentials::read_mimo_tts_key()?.is_some(),
    })
}
#[tauri::command]
pub(crate) fn update_speech_output_settings(
    app: AppHandle,
    input: SpeechOutputInput,
) -> Result<SpeechOutputStatus, String> {
    let value = SpeechOutputSettings {
        provider: input.provider,
        voice: input.voice,
        style: input.style.trim().into(),
    };
    validate(&value)?;
    if input
        .api_key
        .as_ref()
        .is_some_and(|s| s.len() > 1024 || s.contains(['\r', '\n']))
    {
        return Err("API Key 格式无效".into());
    }
    let has_key = match &input.api_key {
        Some(k) => !k.trim().is_empty(),
        None => value.provider != "mimo" || crate::credentials::read_mimo_tts_key()?.is_some(),
    };
    if value.provider == "mimo" && !has_key {
        return Err("请先填写 MiMo API Key".into());
    }
    crate::credentials::update_mimo_tts_key(input.api_key)?;
    crate::storage::write(&path(&app)?, &value)?;
    get_speech_output_settings(app)
}
pub(crate) fn request_body(s: &SpeechOutputSettings, text: &str) -> Value {
    let mut messages = Vec::new();
    if !s.style.is_empty() {
        messages.push(json!({"role":"user","content":s.style}));
    }
    messages.push(json!({"role":"assistant","content":text}));
    json!({"model":"mimo-v2.5-tts","messages":messages,"audio":{"format":"wav","voice":s.voice},"stream":false})
}
fn decode_response(value: &Value) -> Result<Vec<u8>, String> {
    let encoded = value
        .pointer("/choices/0/message/audio/data")
        .and_then(Value::as_str)
        .ok_or("MiMo 未返回语音数据，请检查音色和模型权限")?;
    if encoded.len() > MAX_RESPONSE {
        return Err("MiMo 回复音频过长，请缩短播报内容".into());
    }
    let wav = STANDARD
        .decode(encoded)
        .map_err(|_| "MiMo 音频数据格式错误")?;
    let (rate, samples) = crate::speech::decode_wav_pcm16_mono(&wav)?;
    if rate == 0 || samples.is_empty() {
        return Err("MiMo 返回了空音频".into());
    }
    if samples.len() as f64 / rate as f64 > 40.0 {
        return Err("回复语音超过40秒，请分段朗读".into());
    }
    let samples = crate::speech::resample_to_16khz(rate, &samples);
    Ok(samples
        .into_iter()
        .flat_map(|s| ((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16).to_le_bytes())
        .collect())
}
async fn fetch_pcm(
    client: &reqwest::Client,
    endpoint: &str,
    key: &str,
    s: &SpeechOutputSettings,
    text: &str,
) -> Result<Vec<u8>, String> {
    let response = client
        .post(endpoint)
        .header("api-key", key)
        .json(&request_body(s, text))
        .send()
        .await
        .map_err(|_| "无法连接 MiMo 语音服务，请检查网络后重试")?;
    match response.status().as_u16() {
        200..=299 => {}
        401 | 403 => return Err("MiMo API Key 无效或没有语音模型权限".into()),
        402 => return Err("MiMo 账户额度不足，请检查控制台".into()),
        429 => return Err("MiMo 请求过于频繁或额度已用完，请稍后重试".into()),
        _ => return Err("MiMo 语音服务暂不可用，请稍后重试".into()),
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_RESPONSE as u64)
    {
        return Err("MiMo 回复音频过长".into());
    }
    let mut data = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "MiMo 音频接收中断，请重试")?;
        if data.len() + chunk.len() > MAX_RESPONSE {
            return Err("MiMo 回复音频过长".into());
        }
        data.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&data).map_err(|_| "MiMo 返回格式无效，请重试")?;
    decode_response(&value)
}
pub(crate) async fn synthesize_pcm(app: &AppHandle, text: &str) -> Result<Vec<u8>, String> {
    let s = settings(app)?;
    if s.provider == "system" {
        return crate::device_voice::synthesize(text).await;
    }
    let key =
        crate::credentials::read_mimo_tts_key()?.ok_or("请先在语音输出设置中填写 MiMo API Key")?;
    let text = crate::speech::text_for_speech(text);
    if text.trim().is_empty() {
        return Err("没有可朗读的内容".into());
    }
    if text.chars().count() > 2000 {
        return Err("单次朗读内容过长，请分段朗读".into());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|_| "无法初始化语音服务")?;
    fetch_pcm(&client, ENDPOINT, &key, &s, &text).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
    };
    fn server(status: &str, body: Vec<u8>, inspect: bool) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let status = status.to_owned();
        let thread = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut data = Vec::new();
            let mut buf = [0u8; 2048];
            let header_end = loop {
                let n = stream.read(&mut buf).unwrap();
                assert!(n > 0);
                data.extend_from_slice(&buf[..n]);
                if let Some(i) = data.windows(4).position(|x| x == b"\r\n\r\n") {
                    break i + 4;
                }
            };
            let headers = String::from_utf8_lossy(&data[..header_end]).to_lowercase();
            let count: usize = headers
                .lines()
                .find_map(|l| l.strip_prefix("content-length:"))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            while data.len() < header_end + count {
                let n = stream.read(&mut buf).unwrap();
                assert!(n > 0);
                data.extend_from_slice(&buf[..n]);
            }
            if inspect {
                assert!(headers.contains("api-key: test-private-key"));
                let request: Value =
                    serde_json::from_slice(&data[header_end..header_end + count]).unwrap();
                assert_eq!(request["model"], "mimo-v2.5-tts");
                assert_eq!(request["audio"]["voice"], "冰糖");
                assert_eq!(request["audio"]["format"], "wav");
                assert_eq!(request["messages"][0]["role"], "user");
                assert_eq!(
                    request["messages"][1],
                    json!({"role":"assistant","content":"你好"})
                );
                assert!(!String::from_utf8_lossy(&data[header_end..]).contains("test-private-key"));
            }
            write!(stream,"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
            stream.write_all(&body).unwrap();
        });
        (endpoint, thread)
    }
    #[tokio::test]
    async fn official_contract_and_24khz_audio_become_device_pcm() {
        let pcm: Vec<u8> = (0..480i16).flat_map(|n| n.to_le_bytes()).collect();
        let mut wav = crate::device_voice::pcm_wav(&pcm);
        wav[24..28].copy_from_slice(&24000u32.to_le_bytes());
        wav[28..32].copy_from_slice(&48000u32.to_le_bytes());
        let payload = serde_json::to_vec(
            &json!({"choices":[{"message":{"audio":{"data":STANDARD.encode(wav)}}}]}),
        )
        .unwrap();
        let (endpoint, thread) = server("200 OK", payload, true);
        let audio = fetch_pcm(
            &reqwest::Client::new(),
            &endpoint,
            "test-private-key",
            &SpeechOutputSettings::default(),
            "你好",
        )
        .await
        .unwrap();
        assert_eq!(audio.len(), 320 * 2);
        thread.join().unwrap();
    }
    #[tokio::test]
    async fn provider_errors_do_not_echo_credentials_or_remote_body() {
        for status in [
            "401 Unauthorized",
            "429 Too Many Requests",
            "500 Internal Server Error",
            "302 Found",
        ] {
            let (endpoint, thread) = server(
                status,
                b"test-private-key private remote error".to_vec(),
                false,
            );
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap();
            let error = fetch_pcm(
                &client,
                &endpoint,
                "test-private-key",
                &SpeechOutputSettings::default(),
                "你好",
            )
            .await
            .unwrap_err();
            assert!(!error.contains("test-private-key"));
            assert!(!error.contains("private remote"));
            thread.join().unwrap();
        }
    }
    #[test]
    fn malformed_missing_and_overlong_audio_are_rejected() {
        assert!(decode_response(&json!({"choices":[]})).is_err());
        assert!(
            decode_response(&json!({"choices":[{"message":{"audio":{"data":"not base64"}}}]}))
                .is_err()
        );
        let wav = crate::device_voice::pcm_wav(&vec![0; 16000 * 2 * 41]);
        assert!(decode_response(
            &json!({"choices":[{"message":{"audio":{"data":STANDARD.encode(wav)}}}]})
        )
        .unwrap_err()
        .contains("40秒"));
        let s = SpeechOutputSettings {
            voice: "untrusted".into(),
            ..SpeechOutputSettings::default()
        };
        assert!(validate(&s).is_err());
        let saved = serde_json::to_string(&SpeechOutputSettings::default()).unwrap();
        assert!(!saved.contains("apiKey"));
    }
}
