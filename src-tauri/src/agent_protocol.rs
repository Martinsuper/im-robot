//! Versioned private wire boundary; business logic consumes validated events only.
use serde_json::{json, Value};

pub(super) const VERSION: u64 = 1;

pub(super) fn command(mut value: Value) -> Value {
    value["protocolVersion"] = json!(VERSION);
    value
}

pub(super) fn event(line: &str, request_id: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_str(line).map_err(|_| "Agent 返回了无效的 JSON 数据")?;
    if value["protocolVersion"].as_u64() != Some(VERSION) {
        return Err("Agent 通信协议版本不兼容，请重新准备 Agent 运行时。".into());
    }
    if value["requestId"].as_str() != Some(request_id) {
        return Err("Agent 返回了不属于当前任务的通信数据。".into());
    }
    let required: &[&str] = match value["type"].as_str() {
        Some("started" | "completed" | "cancelled") => &[],
        Some("delta" | "steering-accepted") => &["text"],
        Some("tool-start" | "tool-end") => &["tool", "toolCallId"],
        Some("approval") => &["approvalId", "tool"],
        Some("approval-expired") => &["approvalId"],
        Some("app-tool") => &["callId", "name"],
        Some("failed" | "protocol-error") => &["message"],
        _ => return Err("Agent 返回了未知的事件类型。".into()),
    };
    if required.iter().any(|key| !value[*key].is_string()) {
        return Err("Agent 返回的事件缺少必要字段。".into());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_stale_malformed_and_incompatible_events() {
        for value in [
            json!({"type":"completed","protocolVersion":2,"requestId":"current"}),
            json!({"type":"completed","protocolVersion":1,"requestId":"old"}),
            json!({"type":"delta","protocolVersion":1,"requestId":"current"}),
            json!({"type":"unknown","protocolVersion":1,"requestId":"current"}),
            json!(null),
        ] {
            assert!(event(&value.to_string(), "current").is_err());
        }
        assert!(event("{", "current").is_err());
    }

    #[test]
    fn accepts_current_task_events_and_versions_commands() {
        let value =
            json!({"type":"delta","text":"hello","protocolVersion":VERSION,"requestId":"current"});
        assert_eq!(event(&value.to_string(), "current").unwrap(), value);
        assert_eq!(
            command(json!({"type":"cancel"}))["protocolVersion"],
            VERSION
        );
    }
}
