//! Model tool schemas, normalized calls and result envelopes; does not authorize writes.
use super::{plugin_wire_name, PluginManifest, PluginRegistry, ToolCall};
use crate::providers::{provider_kind, OpenAiToolCallAccumulator, ProviderKind};
use serde_json::{json, Value};

pub(crate) fn provider_tools(provider: &str, manifests: &[PluginManifest]) -> Value {
    let tools = manifests
        .iter()
        .flat_map(|manifest| {
            manifest.tools.iter().map(|tool| {
                let name = plugin_wire_name(&manifest.id, &tool.name);
                match provider_kind(provider) {
                    Some(ProviderKind::Anthropic) => json!({
                        "name": name,
                        "description": tool.description,
                        "input_schema": tool.input_schema,
                    }),
                    _ => json!({
                        "type": "function",
                        "function": {
                            "name": name,
                            "description": tool.description,
                            "parameters": tool.input_schema,
                        }
                    }),
                }
            })
        })
        .collect::<Vec<_>>();
    if provider_kind(provider) == Some(ProviderKind::Gemini) {
        json!([{ "functionDeclarations": tools.into_iter().map(|tool| tool["function"].clone()).collect::<Vec<_>>() }])
    } else {
        Value::Array(tools)
    }
}

pub(crate) fn append_provider_tools(
    body: &mut Value,
    provider: &str,
    manifests: &[PluginManifest],
) {
    match provider_kind(provider) {
        Some(ProviderKind::OpenAiCompatible | ProviderKind::Anthropic) => {
            body["tools"] = provider_tools(provider, manifests);
        }
        Some(ProviderKind::Gemini) => {
            body["tools"] = provider_tools(provider, manifests);
        }
        None => {}
    }
}

pub(crate) fn decode_openai_tool_calls(
    registry: &PluginRegistry,
    calls: Vec<OpenAiToolCallAccumulator>,
) -> Result<Vec<(String, ToolCall)>, String> {
    calls
        .into_iter()
        .map(|call| {
            if call.id.is_empty() || call.name.is_empty() {
                return Err("模型返回的工具调用不完整".to_string());
            }
            let arguments = serde_json::from_str(&call.arguments)
                .map_err(|_| "工具参数不是有效 JSON".to_string())?;
            Ok((call.id, registry.decode_tool_call(&call.name, arguments)?))
        })
        .collect()
}

pub(crate) fn coalesce_calendar_delete_calls(
    calls: Vec<(String, ToolCall)>,
) -> Vec<(String, ToolCall)> {
    let delete_count = calls
        .iter()
        .filter(|(_, call)| call.plugin_id == "piko.calendar" && call.tool_name == "delete_event")
        .count();
    if delete_count <= 1 {
        return calls;
    }

    let events = calls
        .iter()
        .filter(|(_, call)| call.plugin_id == "piko.calendar" && call.tool_name == "delete_event")
        .map(|(_, call)| call.arguments.clone())
        .collect::<Vec<_>>();
    let mut batch = Some(events);
    calls
        .into_iter()
        .filter_map(|(id, mut call)| {
            if call.plugin_id != "piko.calendar" || call.tool_name != "delete_event" {
                return Some((id, call));
            }
            let events = batch.take()?;
            call.tool_name = "delete_event_batch".to_string();
            call.arguments = json!({ "events": events });
            Some((id, call))
        })
        .collect()
}

pub(crate) fn append_provider_tool_results(
    request_body: &mut Value,
    provider: &str,
    calls: &[(String, ToolCall, Value)],
) -> Result<(), String> {
    match provider_kind(provider) {
        Some(ProviderKind::OpenAiCompatible) => {
            let messages = request_body["messages"]
                .as_array_mut()
                .ok_or_else(|| "模型请求消息格式无效".to_string())?;
            messages.push(json!({
                "role": "assistant",
                "content": null,
                "tool_calls": calls.iter().map(|(id, call, _)| json!({
                    "id": id,
                    "type": "function",
                    "function": {
                        "name": plugin_wire_name(&call.plugin_id, &call.tool_name),
                        "arguments": serde_json::to_string(&call.arguments).unwrap_or_default(),
                    }
                })).collect::<Vec<_>>(),
            }));
            messages.extend(calls.iter().map(|(id, _, result)| {
                json!({
                    "role": "tool",
                    "tool_call_id": id,
                    "content": serde_json::to_string(result).unwrap_or_default(),
                })
            }));
        }
        Some(ProviderKind::Anthropic) => {
            let messages = request_body["messages"]
                .as_array_mut()
                .ok_or_else(|| "模型请求消息格式无效".to_string())?;
            messages.push(json!({
                "role": "assistant",
                "content": calls.iter().map(|(id, call, _)| json!({
                    "type": "tool_use",
                    "id": id,
                    "name": plugin_wire_name(&call.plugin_id, &call.tool_name),
                    "input": call.arguments,
                })).collect::<Vec<_>>(),
            }));
            messages.push(json!({
                "role": "user",
                "content": calls.iter().map(|(id, _, result)| json!({
                    "type": "tool_result",
                    "tool_use_id": id,
                    "content": serde_json::to_string(result).unwrap_or_default(),
                })).collect::<Vec<_>>(),
            }));
        }
        Some(ProviderKind::Gemini) => {
            let contents = request_body["contents"]
                .as_array_mut()
                .ok_or_else(|| "模型请求消息格式无效".to_string())?;
            contents.push(json!({
                "role": "model",
                "parts": calls.iter().map(|(_, call, _)| json!({
                    "functionCall": {
                        "name": plugin_wire_name(&call.plugin_id, &call.tool_name),
                        "args": call.arguments,
                    }
                })).collect::<Vec<_>>(),
            }));
            contents.push(json!({
                "role": "user",
                "parts": calls.iter().map(|(_, call, result)| json!({
                    "functionResponse": {
                        "name": plugin_wire_name(&call.plugin_id, &call.tool_name),
                        "response": result,
                    }
                })).collect::<Vec<_>>(),
            }));
        }
        None => return Err("不支持的模型服务类型".to_string()),
    }
    Ok(())
}
