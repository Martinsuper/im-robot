//! AI 提供方适配层：URL 构造、HTTP 客户端、鉴权、SSE 增量解析与工具调用累积。

use crate::settings::{read_api_key, AiSettings};
use serde_json::{json, Value};
use std::time::Duration;

pub fn extract_chat_deltas(provider: &str, line: &str) -> Vec<String> {
    let Some(data) = line.strip_prefix("data:") else {
        return Vec::new();
    };
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return Vec::new();
    }

    let Ok(body) = serde_json::from_str::<Value>(data) else {
        return Vec::new();
    };
    match provider_kind(provider) {
        Some(ProviderKind::Anthropic) => body["delta"]["text"]
            .as_str()
            .map(str::to_string)
            .into_iter()
            .collect(),
        Some(ProviderKind::Gemini) => body["candidates"][0]["content"]["parts"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|part| part["text"].as_str())
            .map(str::to_string)
            .collect(),
        _ => body["choices"][0]["delta"]["content"]
            .as_str()
            .map(str::to_string)
            .into_iter()
            .collect(),
    }
}

pub fn pet_companion_generation_url(settings: &AiSettings) -> Result<String, String> {
    let base_url = normalize_base_url(&settings.base_url);
    match provider_kind(&settings.provider) {
        Some(ProviderKind::OpenAiCompatible) => Ok(format!("{base_url}/chat/completions")),
        Some(ProviderKind::Anthropic) => Ok(format!("{base_url}/messages")),
        Some(ProviderKind::Gemini) => Ok(format!(
            "{base_url}/models/{}:generateContent",
            settings.model.trim_start_matches("models/")
        )),
        None => Err("不支持的模型服务类型".to_string()),
    }
}

pub fn chat_url(settings: &AiSettings) -> Result<String, String> {
    let base_url = normalize_base_url(&settings.base_url);
    match provider_kind(&settings.provider) {
        Some(ProviderKind::OpenAiCompatible) => Ok(format!("{base_url}/chat/completions")),
        Some(ProviderKind::Anthropic) => Ok(format!("{base_url}/messages")),
        Some(ProviderKind::Gemini) => Ok(format!(
            "{base_url}/models/{}:streamGenerateContent?alt=sse",
            settings.model.trim_start_matches("models/")
        )),
        None => Err("不支持的模型服务类型".to_string()),
    }
}

pub fn models_url(settings: &AiSettings) -> String {
    format!("{}/models", normalize_base_url(&settings.base_url))
}

pub fn connection_test_body(settings: &AiSettings) -> Result<Value, String> {
    match provider_kind(&settings.provider) {
        Some(ProviderKind::OpenAiCompatible) => Ok(json!({
            "model": settings.model,
            "messages": [{ "role": "user", "content": "Reply with OK." }],
            "stream": false,
            "max_tokens": 1
        })),
        Some(ProviderKind::Anthropic) => Ok(json!({
            "model": settings.model,
            "max_tokens": 1,
            "messages": [{ "role": "user", "content": "Reply with OK." }]
        })),
        Some(ProviderKind::Gemini) => Ok(json!({
            "contents": [{ "role": "user", "parts": [{ "text": "Reply with OK." }] }],
            "generationConfig": { "maxOutputTokens": 1 }
        })),
        None => Err("不支持的模型服务类型".to_string()),
    }
}

pub async fn send_checked_request(
    request: reqwest::RequestBuilder,
) -> Result<reqwest::Response, String> {
    let response = request
        .send()
        .await
        .map_err(|error| format!("请求失败：{error}"))?;
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response.text().await.unwrap_or_default();
    let detail = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let detail = if detail.chars().count() > 500 {
        format!("{}…", detail.chars().take(500).collect::<String>())
    } else {
        detail
    };
    if detail.is_empty() {
        Err(format!("HTTP {}", status))
    } else {
        Err(format!("HTTP {}：{}", status, detail))
    }
}

pub fn is_local_provider(provider: &str) -> bool {
    matches!(provider, "lmstudio" | "openai-compatible")
}

pub fn validate_ai_settings(settings: &AiSettings) -> Result<(), String> {
    if provider_kind(&settings.provider).is_none() {
        return Err("不支持的模型服务类型".to_string());
    }
    if !(settings.base_url.starts_with("http://") || settings.base_url.starts_with("https://")) {
        return Err("Base URL 必须以 http:// 或 https:// 开头".to_string());
    }
    if settings.model.trim().is_empty() && !is_local_provider(&settings.provider) {
        return Err("模型名称不能为空".to_string());
    }
    if !(0.0..=2.0).contains(&settings.temperature) {
        return Err("Temperature 必须在 0 到 2 之间".to_string());
    }
    if !(5..=600).contains(&settings.timeout_seconds) {
        return Err("超时时间必须在 5 到 600 秒之间".to_string());
    }
    Ok(())
}

pub fn should_bypass_system_proxy(base_url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(base_url) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_matches(['[', ']']);

    host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host == "::1"
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

pub fn http_client(settings: &AiSettings) -> Result<reqwest::Client, String> {
    let mut builder =
        reqwest::Client::builder().timeout(Duration::from_secs(settings.timeout_seconds));
    if should_bypass_system_proxy(&settings.base_url) {
        builder = builder.no_proxy();
    }
    builder.build().map_err(|error| error.to_string())
}

pub fn request_builder(
    client: &reqwest::Client,
    settings: &AiSettings,
    method: reqwest::Method,
    mut url: String,
) -> reqwest::RequestBuilder {
    let Some(api_key) = read_api_key() else {
        return client.request(method, url);
    };
    if provider_kind(&settings.provider) == Some(ProviderKind::Gemini) {
        if let Ok(mut parsed) = reqwest::Url::parse(&url) {
            parsed.query_pairs_mut().append_pair("key", &api_key);
            url = parsed.to_string();
        }
    }
    let builder = client.request(method, url);
    match provider_kind(&settings.provider) {
        Some(ProviderKind::Anthropic) => builder
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01"),
        Some(ProviderKind::Gemini) => builder,
        _ => builder.bearer_auth(api_key),
    }
}

pub fn normalize_base_url(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_string()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ProviderKind {
    OpenAiCompatible,
    Anthropic,
    Gemini,
}

pub fn provider_kind(provider: &str) -> Option<ProviderKind> {
    match provider {
        "openai-compatible" | "deepseek" | "dashscope" | "lmstudio" => {
            Some(ProviderKind::OpenAiCompatible)
        }
        "anthropic" => Some(ProviderKind::Anthropic),
        "gemini" => Some(ProviderKind::Gemini),
        _ => None,
    }
}

pub fn update_openai_tool_calls(line: &str, calls: &mut Vec<OpenAiToolCallAccumulator>) {
    let Some(data) = line.strip_prefix("data:") else {
        return;
    };
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return;
    }
    let Ok(body) = serde_json::from_str::<Value>(data) else {
        return;
    };
    let Some(tool_calls) = body["choices"][0]["delta"]["tool_calls"].as_array() else {
        return;
    };
    for tool_call in tool_calls {
        let index = tool_call["index"].as_u64().unwrap_or(0) as usize;
        while calls.len() <= index {
            calls.push(OpenAiToolCallAccumulator::default());
        }
        let call = &mut calls[index];
        call.stream_index = index;
        if let Some(id) = tool_call["id"].as_str() {
            call.id.push_str(id);
        }
        if let Some(name) = tool_call["function"]["name"].as_str() {
            call.name.push_str(name);
        }
        if let Some(arguments) = tool_call["function"]["arguments"].as_str() {
            call.arguments.push_str(arguments);
        }
    }
}

pub fn update_anthropic_tool_calls(line: &str, calls: &mut Vec<OpenAiToolCallAccumulator>) {
    let Some(data) = line.strip_prefix("data:") else {
        return;
    };
    let Ok(body) = serde_json::from_str::<Value>(data.trim()) else {
        return;
    };
    let is_start =
        body["type"] == "content_block_start" && body["content_block"]["type"] == "tool_use";
    let is_delta =
        body["type"] == "content_block_delta" && body["delta"]["type"] == "input_json_delta";
    if !is_start && !is_delta {
        return;
    }
    let index = body["index"].as_u64().unwrap_or(0) as usize;
    if is_start {
        calls.push(OpenAiToolCallAccumulator {
            stream_index: index,
            ..Default::default()
        });
    }
    let Some(call) = calls.iter_mut().find(|call| call.stream_index == index) else {
        return;
    };
    if is_start {
        call.id = body["content_block"]["id"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        call.name = body["content_block"]["name"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        call.arguments = body["content_block"]["input"].to_string();
    }
    if is_delta {
        if call.arguments == "{}" {
            call.arguments.clear();
        }
        call.arguments
            .push_str(body["delta"]["partial_json"].as_str().unwrap_or_default());
    }
}

pub fn update_gemini_tool_calls(line: &str, calls: &mut Vec<OpenAiToolCallAccumulator>) {
    let Some(data) = line.strip_prefix("data:") else {
        return;
    };
    let Ok(body) = serde_json::from_str::<Value>(data.trim()) else {
        return;
    };
    let Some(parts) = body["candidates"][0]["content"]["parts"].as_array() else {
        return;
    };
    for part in parts {
        let Some(name) = part["functionCall"]["name"].as_str() else {
            continue;
        };
        let call = OpenAiToolCallAccumulator {
            stream_index: calls.len(),
            id: format!("gemini-call-{}", calls.len()),
            name: name.to_string(),
            arguments: part["functionCall"]["args"].to_string(),
        };
        if !calls
            .iter()
            .any(|existing| existing.name == call.name && existing.arguments == call.arguments)
        {
            calls.push(call);
        }
    }
}

pub fn update_provider_tool_calls(
    provider: &str,
    line: &str,
    calls: &mut Vec<OpenAiToolCallAccumulator>,
) {
    match provider_kind(provider) {
        Some(ProviderKind::Anthropic) => update_anthropic_tool_calls(line, calls),
        Some(ProviderKind::Gemini) => update_gemini_tool_calls(line, calls),
        _ => update_openai_tool_calls(line, calls),
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct OpenAiToolCallAccumulator {
    stream_index: usize,
    id: String,
    name: String,
    arguments: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    id: String,
}
