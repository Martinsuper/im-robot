//! Provider routing, HTTP transport, discovery, and streaming protocol decoding.
use crate::app_settings::AiSettings;
use crate::credentials::read_api_key;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

#[path = "providers_commands.rs"]
pub(crate) mod commands;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelInfo {
    id: String,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum ProviderKind {
    OpenAiCompatible,
    Anthropic,
    Gemini,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct OpenAiToolCallAccumulator {
    pub(crate) stream_index: usize,
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) arguments: String,
}

pub(crate) fn normalize_base_url(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_string()
}

pub(crate) fn provider_kind(provider: &str) -> Option<ProviderKind> {
    match provider {
        // ollama 说的是 OpenAI 兼容协议，归到同一分支即可。
        "openai" | "openai-compatible" | "deepseek" | "dashscope" | "lmstudio" | "ollama" => {
            Some(ProviderKind::OpenAiCompatible)
        }
        "anthropic" => Some(ProviderKind::Anthropic),
        "gemini" => Some(ProviderKind::Gemini),
        _ => None,
    }
}

pub(crate) fn is_local_provider(provider: &str) -> bool {
    matches!(provider, "lmstudio" | "ollama" | "openai-compatible")
}

pub(crate) fn validate_ai_settings(settings: &AiSettings) -> Result<(), String> {
    if provider_kind(&settings.provider).is_none() {
        return Err("不支持的模型服务类型".to_string());
    }
    if !(settings.base_url.starts_with("http://") || settings.base_url.starts_with("https://")) {
        return Err("Base URL 必须以 http:// 或 https:// 开头".to_string());
    }
    if settings.model.trim().is_empty() && !is_local_provider(&settings.provider) {
        return Err("模型名称不能为空".to_string());
    }
    if settings.speech_model.trim().is_empty() {
        return Err("语音识别模型名称不能为空".to_string());
    }
    if !(0.0..=2.0).contains(&settings.temperature) {
        return Err("Temperature 必须在 0 到 2 之间".to_string());
    }
    if !(5..=600).contains(&settings.timeout_seconds) {
        return Err("超时时间必须在 5 到 600 秒之间".to_string());
    }
    if settings.context_window != 0 && !(2048..=2_000_000).contains(&settings.context_window) {
        return Err("上下文窗口应为 0（自动）或 2048 到 2000000".into());
    }
    if settings.max_output_tokens != 0 && !(128..=200_000).contains(&settings.max_output_tokens) {
        return Err("最大输出应为 0（自动）或 128 到 200000".into());
    }
    if settings.context_window > 0 && settings.max_output_tokens >= settings.context_window {
        return Err("最大输出必须小于上下文窗口".into());
    }
    Ok(())
}

pub(crate) fn should_bypass_system_proxy(base_url: &str) -> bool {
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

pub(crate) fn http_client(settings: &AiSettings) -> Result<reqwest::Client, String> {
    let mut builder =
        reqwest::Client::builder().timeout(Duration::from_secs(settings.timeout_seconds));
    if should_bypass_system_proxy(&settings.base_url) {
        builder = builder.no_proxy();
    }
    builder.build().map_err(|error| error.to_string())
}

pub(crate) fn request_builder(
    client: &reqwest::Client,
    settings: &AiSettings,
    method: reqwest::Method,
    url: String,
) -> reqwest::RequestBuilder {
    request_builder_with_key(client, settings, method, url, read_api_key())
}

fn request_builder_with_key(
    client: &reqwest::Client,
    settings: &AiSettings,
    method: reqwest::Method,
    mut url: String,
    api_key: Option<String>,
) -> reqwest::RequestBuilder {
    let Some(api_key) = api_key else {
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

pub(crate) fn models_url(settings: &AiSettings) -> String {
    format!("{}/models", normalize_base_url(&settings.base_url))
}

pub(crate) fn chat_url(settings: &AiSettings) -> Result<String, String> {
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

pub(crate) fn update_openai_tool_calls(line: &str, calls: &mut Vec<OpenAiToolCallAccumulator>) {
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

pub(crate) fn update_anthropic_tool_calls(line: &str, calls: &mut Vec<OpenAiToolCallAccumulator>) {
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

pub(crate) fn update_gemini_tool_calls(line: &str, calls: &mut Vec<OpenAiToolCallAccumulator>) {
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

pub(crate) fn update_provider_tool_calls(
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

pub(crate) fn extract_model_ids(provider: &str, body: &Value) -> Vec<String> {
    let (items, field) = if provider_kind(provider) == Some(ProviderKind::Gemini) {
        (body["models"].as_array(), "name")
    } else {
        (body["data"].as_array(), "id")
    };
    items
        .into_iter()
        .flatten()
        .filter_map(|model| model[field].as_str())
        .map(|id| id.trim_start_matches("models/").to_string())
        .collect()
}

pub(crate) fn pet_companion_generation_url(settings: &AiSettings) -> Result<String, String> {
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

pub(crate) fn extract_chat_deltas(provider: &str, line: &str) -> Vec<String> {
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

pub(crate) async fn send_chat_request(
    client: &reqwest::Client,
    settings: &AiSettings,
    body: &Value,
) -> Result<reqwest::Response, String> {
    request_builder(client, settings, reqwest::Method::POST, chat_url(settings)?)
        .json(body)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_base_url() {
        assert_eq!(
            normalize_base_url(" http://localhost:11434/v1/ "),
            "http://localhost:11434/v1"
        );
    }

    #[test]
    fn extracts_anthropic_and_gemini_chat_deltas() {
        assert_eq!(
            extract_chat_deltas(
                "anthropic",
                r#"data: {"delta":{"type":"text_delta","text":"你好"}}"#
            ),
            vec!["你好".to_string()]
        );
        assert_eq!(
            extract_chat_deltas(
                "gemini",
                r#"data: {"candidates":[{"content":{"parts":[{"text":"你"},{"text":"好"}]}}]}"#
            ),
            vec!["你".to_string(), "好".to_string()]
        );
    }

    #[test]
    fn builds_provider_specific_urls_and_model_lists() {
        let mut ai = AiSettings {
            provider: "anthropic".to_string(),
            base_url: "https://api.anthropic.com/v1".to_string(),
            ..Default::default()
        };
        assert_eq!(
            chat_url(&ai).unwrap(),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            extract_model_ids(
                "anthropic",
                &serde_json::json!({ "data": [{ "id": "claude" }] })
            ),
            vec!["claude".to_string()]
        );

        ai.provider = "gemini".to_string();
        ai.base_url = "https://generativelanguage.googleapis.com/v1beta".to_string();
        ai.model = "models/gemini-test".to_string();
        assert_eq!(
            chat_url(&ai).unwrap(),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse"
        );
        assert_eq!(
            extract_model_ids(
                "gemini",
                &serde_json::json!({ "models": [{ "name": "models/gemini-test" }] })
            ),
            vec!["gemini-test".to_string()]
        );
    }

    #[test]
    fn bypasses_system_proxy_for_local_model_services() {
        assert!(should_bypass_system_proxy("http://localhost:11434/v1"));
        assert!(should_bypass_system_proxy("http://127.0.0.1:1234/v1"));
        assert!(should_bypass_system_proxy("http://[::1]:8000/v1"));
        assert!(should_bypass_system_proxy(
            "http://model-server.local:8000/v1"
        ));
        assert!(!should_bypass_system_proxy("https://api.example.com/v1"));
    }

    #[test]
    fn authentication_headers_match_each_provider_without_putting_keys_in_payloads() {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        for provider in ["openai", "openai-compatible", "anthropic"] {
            let settings = AiSettings {
                provider: provider.into(),
                ..AiSettings::default()
            };
            let request = request_builder_with_key(
                &client,
                &settings,
                reqwest::Method::POST,
                "http://127.0.0.1/v1/messages".into(),
                Some("contract-test-key".into()),
            )
            .json(&serde_json::json!({"messages":[]}))
            .build()
            .unwrap();
            assert!(!request.url().as_str().contains("contract-test-key"));
            assert!(
                !std::str::from_utf8(request.body().unwrap().as_bytes().unwrap())
                    .unwrap()
                    .contains("contract-test-key")
            );
            if provider == "anthropic" {
                assert_eq!(request.headers()["x-api-key"], "contract-test-key");
                assert_eq!(request.headers()["anthropic-version"], "2023-06-01");
                assert!(!request.headers().contains_key("authorization"));
            } else {
                assert_eq!(
                    request.headers()["authorization"],
                    "Bearer contract-test-key"
                );
                assert!(!request.headers().contains_key("x-api-key"));
            }
        }
    }

    #[test]
    fn gemini_auth_preserves_stream_query_and_encodes_the_key() {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let settings = AiSettings {
            provider: "gemini".into(),
            ..AiSettings::default()
        };
        let request = request_builder_with_key(
            &client,
            &settings,
            reqwest::Method::POST,
            "http://127.0.0.1/v1/models/test:streamGenerateContent?alt=sse".into(),
            Some("test +/=& key".into()),
        )
        .build()
        .unwrap();
        let pairs: Vec<_> = request.url().query_pairs().collect();
        assert!(pairs
            .iter()
            .any(|(key, value)| key == "alt" && value == "sse"));
        assert!(pairs
            .iter()
            .any(|(key, value)| key == "key" && value == "test +/=& key"));
        assert!(!request.headers().contains_key("authorization"));
        assert!(!request.headers().contains_key("x-api-key"));
    }

    #[test]
    fn absent_credentials_leave_local_service_requests_unauthenticated() {
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        for provider in [
            "ollama",
            "lmstudio",
            "openai-compatible",
            "anthropic",
            "gemini",
        ] {
            let settings = AiSettings {
                provider: provider.into(),
                ..AiSettings::default()
            };
            let url = "http://127.0.0.1:11434/v1/models";
            let request = request_builder_with_key(
                &client,
                &settings,
                reqwest::Method::GET,
                url.into(),
                None,
            )
            .build()
            .unwrap();
            assert_eq!(request.url().as_str(), url);
            assert!(!request.headers().contains_key("authorization"));
            assert!(!request.headers().contains_key("x-api-key"));
        }
    }
}
