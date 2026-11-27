//! HTTP 全链路集成测试：用 wiremock 顶替模型服务端，驱动 `stream_chat` 实际使用的
//! 请求构造 / SSE 流式解析 / 工具调用回传链路。四类覆盖：正常流 / 中断流 / 非 200 /
//! 工具调用回传。所有用例无窗口、无系统依赖，可在 Linux/macOS/Windows CI 上直接运行。
use super::*;
use crate::chat_stream::SseLines;
use crate::plugins::bridge::decode_openai_tool_calls;
use crate::providers::{
    extract_chat_deltas, http_client, send_chat_request, update_provider_tool_calls,
    validate_ai_settings, OpenAiToolCallAccumulator,
};
use serde_json::Value;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Respond, ResponseTemplate};

struct Harness {
    server: MockServer,
    settings: AppSettings,
}

impl Harness {
    async fn new() -> Self {
        // 生产启动时由 bootstrap 初始化密钥目录；测试里用临时目录做同样的初始化，
        // 让 send_chat_request 的 Authorization 读取走与线上一致的路径。
        static CREDENTIALS: std::sync::Once = std::sync::Once::new();
        CREDENTIALS.call_once(|| {
            let _ =
                crate::credentials::initialize(std::env::temp_dir().join("im-robot-http-tests"));
        });
        let server = MockServer::start().await;
        let mut settings = AppSettings::default();
        settings.ai.provider = "openai-compatible".into();
        settings.ai.base_url = format!("{}/v1", server.uri());
        settings.ai.model = "mock-model".into();
        Self { server, settings }
    }

    /// 与 `stream_chat` 一致：先构造正文，再注册插件工具 schema。
    fn request_body(&self) -> Value {
        let mut body = chat_request_body(&self.settings, &[], "你好", None, None, None)
            .expect("build chat request");
        append_provider_tools(
            &mut body,
            &self.settings.ai.provider,
            &PluginRegistry::with_builtin_plugins().manifests(),
        );
        body
    }

    async fn send(&self, body: &Value) -> Result<reqwest::Response, String> {
        validate_ai_settings(&self.settings.ai).expect("test settings must be valid");
        let client = http_client(&self.settings.ai).expect("build http client");
        send_chat_request(&client, &self.settings.ai, body).await
    }
}

fn sse(deltas: &[String]) -> String {
    let mut body = String::new();
    for delta in deltas {
        body.push_str("data: ");
        body.push_str(delta);
        body.push_str("\n\n");
    }
    body.push_str("data: [DONE]\n\n");
    body
}

fn text_delta(text: &str) -> String {
    json!({"choices":[{"delta":{"content":text}}]}).to_string()
}

fn event_stream(body: String) -> ResponseTemplate {
    ResponseTemplate::new(200)
        .insert_header("content-type", "text/event-stream")
        .set_body_string(body)
}

/// 复刻 `stream_chat` 的逐块解析循环：跨 chunk 的 SSE 行、文本 delta 与工具调用累加。
async fn collect(
    mut response: reqwest::Response,
    provider: &str,
) -> Result<(String, Vec<OpenAiToolCallAccumulator>), String> {
    let mut buffer = SseLines::default();
    let mut text = String::new();
    let mut calls = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        for line in buffer.push(&chunk)? {
            let line = line.trim();
            update_provider_tool_calls(provider, line, &mut calls);
            for delta in extract_chat_deltas(provider, line) {
                text.push_str(&delta);
            }
        }
    }
    let tail = buffer.finish()?;
    update_provider_tool_calls(provider, tail.trim(), &mut calls);
    for delta in extract_chat_deltas(provider, tail.trim()) {
        text.push_str(&delta);
    }
    Ok((text, calls))
}

#[tokio::test]
async fn normal_stream_accumulates_text_and_advertises_tools() {
    let harness = Harness::new().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(event_stream(sse(&[
            text_delta("你好"),
            text_delta("，世界"),
        ])))
        .expect(1)
        .mount(&harness.server)
        .await;

    let body = harness.request_body();
    assert_eq!(body["stream"], true);
    assert_eq!(body["model"], "mock-model");
    assert!(body["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| { tool["function"]["name"].as_str() == Some("piko_memos__create_memo") }));

    let response = harness.send(&body).await.expect("normal 200 response");
    let (text, calls) = collect(response, "openai-compatible")
        .await
        .expect("parse SSE stream");
    assert_eq!(text, "你好，世界");
    assert!(calls.is_empty());

    let requests = harness.server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
    let sent: Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert_eq!(sent["messages"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn interrupted_stream_pre_cancelled_never_hits_the_model() {
    let harness = Harness::new().await;
    // 不挂载任何 mock：若请求真的发出，wiremock 会返回 404，测试随即失败。
    let token = CancellationToken::new();
    token.cancel();
    let body = harness.request_body();
    let cancelled = tokio::select! {
        biased;
        _ = token.cancelled() => true,
        result = harness.send(&body) => {
            result.expect("no request should be sent");
            false
        }
    };
    assert!(cancelled, "cancellation must win over the model request");
    assert!(
        harness.server.received_requests().await.unwrap().is_empty(),
        "pre-cancelled stream must not call the model"
    );
}

/// 响应到达的瞬间取消，模拟流式回复被用户中途打断。
struct CancelOnResponse {
    token: CancellationToken,
    body: String,
}

impl Respond for CancelOnResponse {
    fn respond(&self, _request: &wiremock::Request) -> ResponseTemplate {
        self.token.cancel();
        event_stream(self.body.clone())
    }
}

#[tokio::test]
async fn interrupted_stream_mid_flight_returns_cancelled() {
    let harness = Harness::new().await;
    let token = CancellationToken::new();
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(CancelOnResponse {
            token: token.clone(),
            body: sse(&[text_delta("半截回复")]),
        })
        .mount(&harness.server)
        .await;

    let body = harness.request_body();
    let cancelled = tokio::select! {
        biased;
        _ = token.cancelled() => true,
        result = harness.send(&body) => {
            result.expect("mock responds 200");
            false
        }
    };
    assert!(
        cancelled,
        "in-flight cancellation must short-circuit the stream"
    );
}

#[tokio::test]
async fn non_200_response_is_reported_as_an_error() {
    let harness = Harness::new().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(503).set_body_string("service unavailable"))
        .expect(2)
        .mount(&harness.server)
        .await;

    let body = harness.request_body();
    for _ in 0..2 {
        let error = harness.send(&body).await.expect_err("non-200 must fail");
        assert!(!error.is_empty());
    }
    let requests = harness.server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 2);
}

#[tokio::test]
async fn tool_call_delta_is_decoded_back_into_a_plugin_call() {
    let harness = Harness::new().await;
    let delta = json!({
        "choices": [{
            "delta": {
                "tool_calls": [{
                    "index": 0,
                    "id": "call-1",
                    "function": {
                        "name": "piko_memos__create_memo",
                        "arguments": json!({"title": "评审", "content": "周五同步"}).to_string(),
                    }
                }]
            }
        }]
    })
    .to_string();
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(event_stream(sse(&[delta])))
        .expect(1)
        .mount(&harness.server)
        .await;

    let response = harness
        .send(&harness.request_body())
        .await
        .expect("200 response");
    let (text, calls) = collect(response, "openai-compatible")
        .await
        .expect("parse tool call stream");
    assert_eq!(
        text, "",
        "tool call must not be mistaken for assistant text"
    );
    assert_eq!(calls.len(), 1);

    let decoded = decode_openai_tool_calls(&PluginRegistry::with_builtin_plugins(), calls)
        .expect("decode tool call");
    assert_eq!(decoded.len(), 1);
    let (id, call) = &decoded[0];
    assert_eq!(id, "call-1");
    assert_eq!(call.plugin_id, "piko.memos");
    assert_eq!(call.tool_name, "create_memo");
    assert_eq!(call.arguments["title"], "评审");
    assert_eq!(call.arguments["content"], "周五同步");
}

#[tokio::test]
async fn truncated_stream_keeps_the_received_prefix() {
    let harness = Harness::new().await;
    // 服务端中途关闭连接：没有 [DONE]，但已收到的 delta 仍应被保留，且不能 panic。
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(event_stream(format!("data: {}\n", text_delta("已收到"))))
        .mount(&harness.server)
        .await;

    let response = harness
        .send(&harness.request_body())
        .await
        .expect("200 response");
    let (text, calls) = collect(response, "openai-compatible")
        .await
        .expect("truncated stream still parses");
    assert_eq!(text, "已收到");
    assert!(calls.is_empty());
}
