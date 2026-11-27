//! Registry, manifest and wire compatibility regression tests migrated with the implementation.
use super::bridge::*;
use super::declarative::{validate_declarative_plugin, DeclarativePluginPackage};
use super::*;
use crate::providers::{
    update_anthropic_tool_calls, update_gemini_tool_calls, update_openai_tool_calls,
    OpenAiToolCallAccumulator,
};

#[test]
fn registers_the_builtin_business_plugins() {
    let manifests = PluginRegistry::with_builtin_plugins().manifests();
    assert_eq!(manifests.len(), 5);
    assert_eq!(manifests[0].id, "piko.calendar");
    assert_eq!(manifests[1].id, "piko.focus");
    assert_eq!(manifests[3].id, "piko.memos");
    assert_eq!(manifests[4].id, "piko.reminders");
    assert_eq!(manifests[0].tools[0].name, "list_events");
    assert_eq!(manifests[0].tools[4].name, "delete_event");
    assert_eq!(manifests[0].tools[5].name, "delete_event_batch");
    assert_eq!(manifests[0].tools[5].risk, "sensitive");
    assert_eq!(manifests[0].tools[5].confirmation, "always");
    assert_eq!(manifests[3].tools[0].name, "list_memos");
    assert_eq!(manifests[3].tools[1].name, "create_memo");
    assert_eq!(manifests[3].tools[1].risk, "write");
    assert_eq!(manifests[3].tools[1].confirmation, "always");
    assert_eq!(manifests[4].tools[0].name, "list_reminders");
    assert_eq!(manifests[4].tools[2].name, "delete_reminder");
    assert_eq!(manifests[4].tools[1].risk, "write");
    assert_eq!(manifests[4].tools[2].risk, "sensitive");
    assert_eq!(manifests[4].tools[2].confirmation, "always");
    assert_eq!(manifests[2].id, "piko.knowledge");
    assert_eq!(manifests[2].tools[0].name, "search_knowledge");
    assert_eq!(manifests[2].tools[0].risk, "read");
    assert_eq!(manifests[2].tools[0].confirmation, "never");
}

#[test]
fn maps_plugin_tools_to_provider_specific_schemas() {
    let manifests = PluginRegistry::with_builtin_plugins().manifests();
    let openai = provider_tools("openai-compatible", &manifests);
    let anthropic = provider_tools("anthropic", &manifests);
    let gemini = provider_tools("gemini", &manifests);

    assert_eq!(openai[0]["type"], "function");
    assert!(openai[0]["function"]["name"]
        .as_str()
        .unwrap()
        .contains("__"));
    assert!(anthropic[0]["input_schema"].is_object());
    assert!(gemini[0]["functionDeclarations"].is_array());
}

#[test]
fn aggregates_and_decodes_openai_streaming_tool_calls() {
    let mut calls = Vec::<OpenAiToolCallAccumulator>::new();
    update_openai_tool_calls(
        r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"piko_calendar__create_event","arguments":"{\"title\":\"评审\","}}]}}]}"#,
        &mut calls,
    );
    update_openai_tool_calls(
        r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"startAt\":100,\"endAt\":200}"}}]}}]}"#,
        &mut calls,
    );

    let decoded = decode_openai_tool_calls(&PluginRegistry::with_builtin_plugins(), calls).unwrap();
    assert_eq!(decoded[0].0, "call-1");
    assert_eq!(decoded[0].1.plugin_id, "piko.calendar");
    assert_eq!(decoded[0].1.tool_name, "create_event");
    assert_eq!(decoded[0].1.arguments["title"], "评审");
}

#[test]
fn aggregates_anthropic_and_gemini_tool_calls() {
    let mut anthropic = Vec::new();
    update_anthropic_tool_calls(
        r#"data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool-1","name":"piko_calendar__list_events","input":{}}}"#,
        &mut anthropic,
    );
    let decoded =
        decode_openai_tool_calls(&PluginRegistry::with_builtin_plugins(), anthropic).unwrap();
    assert_eq!(decoded[0].0, "tool-1");
    assert_eq!(decoded[0].1.tool_name, "list_events");

    let mut gemini = Vec::new();
    update_gemini_tool_calls(
        r#"data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"piko_calendar__list_events","args":{}}}]}}]}"#,
        &mut gemini,
    );
    let decoded =
        decode_openai_tool_calls(&PluginRegistry::with_builtin_plugins(), gemini).unwrap();
    assert_eq!(decoded[0].1.tool_name, "list_events");
}

#[test]
fn appends_provider_specific_tool_results() {
    let call = ToolCall {
        plugin_id: "piko.calendar".to_string(),
        tool_name: "list_events".to_string(),
        arguments: serde_json::json!({}),
    };
    let calls = vec![("call-1".to_string(), call, serde_json::json!([]))];
    let mut anthropic = serde_json::json!({ "messages": [] });
    append_provider_tool_results(&mut anthropic, "anthropic", &calls).unwrap();
    assert_eq!(anthropic["messages"][0]["content"][0]["type"], "tool_use");
    assert_eq!(
        anthropic["messages"][1]["content"][0]["type"],
        "tool_result"
    );

    let mut gemini = serde_json::json!({ "contents": [] });
    append_provider_tool_results(&mut gemini, "gemini", &calls).unwrap();
    assert!(gemini["contents"][0]["parts"][0]["functionCall"].is_object());
    assert!(gemini["contents"][1]["parts"][0]["functionResponse"].is_object());
}

#[test]
fn accepts_only_read_only_declarative_plugins() {
    let mut responses = std::collections::HashMap::new();
    responses.insert(
        "lookup".to_string(),
        serde_json::json!({ "answer": "Piko" }),
    );
    let package = DeclarativePluginPackage {
        manifest: PluginManifest {
            id: "piko.external.team-info".to_string(),
            name: "团队说明".to_string(),
            version: "1.0.0".to_string(),
            description: "固定团队说明".to_string(),
            tools: vec![PluginToolManifest {
                name: "lookup".to_string(),
                description: "读取团队说明".to_string(),
                input_schema: serde_json::json!({ "type": "object", "properties": {} }),
                risk: "read".to_string(),
                confirmation: "never".to_string(),
            }],
        },
        runtime: None,
        module: None,
        responses,
    };
    assert!(validate_declarative_plugin(&package).is_ok());

    let mut unsafe_package = package.clone();
    unsafe_package.manifest.tools[0].risk = "write".to_string();
    assert!(validate_declarative_plugin(&unsafe_package).is_err());
}

/// `execute_wasm_plugin` 的确定性用例：用 WAT 现场编译极小 WASI 模块，
/// 覆盖合法 JSON 回传 / 空输出 / 非 JSON 输出 / 模块路径越界四条分支。
#[cfg(feature = "wasm-plugins")]
mod wasm_execution_tests {
    use super::*;
    use crate::plugins::declarative::execute_wasm_plugin;
    use serde_json::json;
    use std::path::Path;

    const ECHO_MODULE: &str = r#"(module
        (import "wasi_snapshot_preview1" "fd_read" (func $read (param i32 i32 i32 i32) (result i32)))
        (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
        (memory (export "memory") 1)
        (func (export "_start")
            ;; 输入缓冲区放在 1024，避免覆盖 0..32 的 iovec/长度 metadata。
            (i32.store (i32.const 0) (i32.const 1024))
            (i32.store (i32.const 4) (i32.const 8192))
            (drop (call $read (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 8)))
            (i32.store (i32.const 16) (i32.const 1024))
            (i32.store (i32.const 20) (i32.load (i32.const 8)))
            (drop (call $write (i32.const 1) (i32.const 16) (i32.const 1) (i32.const 24)))
        ))"#;

    const SILENT_MODULE: &str = r#"(module (func (export "_start")))"#;

    const PLAIN_TEXT_MODULE: &str = r#"(module
        (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
        (memory (export "memory") 1)
        (data (i32.const 100) "not json")
        (func (export "_start")
            (i32.store (i32.const 0) (i32.const 100))
            (i32.store (i32.const 4) (i32.const 8))
            (drop (call $write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8)))
        ))"#;

    fn package(module: Option<&str>) -> DeclarativePluginPackage {
        DeclarativePluginPackage {
            manifest: PluginManifest {
                id: "piko.external.echo".into(),
                name: "Echo".into(),
                version: "1.0.0".into(),
                description: "deterministic test plugin".into(),
                tools: vec![PluginToolManifest {
                    name: "lookup".into(),
                    description: "echo input".into(),
                    input_schema: json!({"type": "object"}),
                    risk: "pure".into(),
                    confirmation: "never".into(),
                }],
            },
            responses: Default::default(),
            runtime: Some("wasm".into()),
            module: module.map(str::to_string),
        }
    }

    fn write_module(directory: &Path, name: &str, source: &str) {
        let bytes = wat::parse_str(source).expect("compile WAT");
        std::fs::write(directory.join(name), bytes).expect("write wasm module");
    }

    fn run(package: &DeclarativePluginPackage, directory: &Path) -> Result<Value, String> {
        let app = tauri::test::mock_app();
        execute_wasm_plugin(
            app.handle(),
            directory,
            package,
            "lookup",
            json!({"value": 42}),
        )
    }

    #[test]
    fn valid_json_stdout_is_returned_verbatim() {
        let directory = tempfile::tempdir().unwrap();
        write_module(directory.path(), "plugin.wasm", ECHO_MODULE);
        let result = run(&package(Some("plugin.wasm")), directory.path()).unwrap();
        assert_eq!(result["pluginId"], "piko.external.echo");
        assert_eq!(result["toolName"], "lookup");
        assert_eq!(result["arguments"]["value"], 42);
        assert_eq!(result["manifest"]["id"], "piko.external.echo");
    }

    #[test]
    fn empty_stdout_yields_a_minimal_success_envelope() {
        let directory = tempfile::tempdir().unwrap();
        write_module(directory.path(), "plugin.wasm", SILENT_MODULE);
        let result = run(&package(Some("plugin.wasm")), directory.path()).unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(result["pluginId"], "piko.external.echo");
        assert_eq!(result["toolName"], "lookup");
        assert_eq!(result["stderr"], "");
        assert!(result.get("raw").is_none());
    }

    #[test]
    fn non_json_stdout_is_preserved_as_raw_text() {
        let directory = tempfile::tempdir().unwrap();
        write_module(directory.path(), "plugin.wasm", PLAIN_TEXT_MODULE);
        let result = run(&package(Some("plugin.wasm")), directory.path()).unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(result["raw"], "not json");
        assert_eq!(result["stderr"], "");
    }

    #[test]
    fn module_path_outside_plugin_directory_is_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let error = run(&package(Some("../outside.wasm")), directory.path()).unwrap_err();
        assert!(!error.is_empty());
        assert!(run(&package(None), directory.path()).is_err());
    }
}
