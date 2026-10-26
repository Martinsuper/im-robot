//! Cross-boundary application contract tests.

use crate::actions::drafts::action_draft_from_tool_call;
use crate::ambient::idle_threshold_seconds;
use crate::ambient::next_idle_state;
use crate::app_settings::AiSettings;
use crate::app_settings::AppSettings;
use crate::app_updates::version_parts;
use crate::attachments::read_text_attachment;
use crate::attachments::validate_save_path;
use crate::attachments::TextAttachment;
use crate::calendar_service::calendar_event_batch_input_from_value;
use crate::chat::build_attachment_prompt;
use crate::chat::chat_request_body;
use crate::chat::looks_like_unconfirmed_local_action_response;
use crate::chat::prompt_requests_local_action;
use crate::chat::system_prompt;
use crate::chat_session::ChatHistoryEntry;
use crate::common::parse_data_url;
use crate::desktop::clamp_pet_position;
use crate::desktop::monitor_contains;
use crate::favorites::html_favorite_title;
use crate::plugins::bridge::append_provider_tools;
use crate::plugins::bridge::coalesce_calendar_delete_calls;
use crate::plugins::PluginRegistry;
use crate::plugins::ToolCall;
use crate::providers::chat_url;
use crate::providers::extract_chat_deltas;
use crate::providers::extract_model_ids;
use crate::providers::is_local_provider;
use crate::providers::models_url;
use crate::providers::provider_kind;
use crate::providers::should_bypass_system_proxy;
use crate::providers::validate_ai_settings;
use crate::providers::ProviderKind;
use crate::reminder_schedule::next_repeat_due;
use crate::runtime_types::append_session_chat_history;
use crate::runtime_types::ChatEvent;
#[cfg(target_os = "macos")]
use crate::screen_capture::CaptureSelection;
use crate::screen_capture::ScreenCapture;
use crate::speech::text_for_speech;
use chrono::{Local, TimeZone};
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize};

#[test]
fn html_favorite_title_uses_first_text_line() {
    assert_eq!(
        html_favorite_title("<h1>计算器</h1><p>内容</p>"),
        "计算器 内容"
    );
    assert!(html_favorite_title("<div></div>").starts_with("HTML 收藏"));
}

#[test]
fn detects_a_position_inside_monitor_bounds() {
    assert!(monitor_contains(
        PhysicalPosition::new(100, 200),
        PhysicalSize::new(1920, 1080),
        PhysicalPosition::new(110, 210),
    ));
}

#[test]
fn rejects_a_position_outside_monitor_bounds() {
    assert!(!monitor_contains(
        PhysicalPosition::new(100, 200),
        PhysicalSize::new(1920, 1080),
        PhysicalPosition::new(99, 210),
    ));
}

#[test]
fn clamps_pet_position_to_keep_a_visible_edge() {
    let clamped = clamp_pet_position(
        LogicalPosition::new(-300.0, 1200.0),
        LogicalSize::new(156.0, 156.0),
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(1440.0, 900.0),
    );

    assert_eq!(clamped, LogicalPosition::new(-116.0, 860.0));
}

#[test]
fn removes_emoji_components_before_local_speech() {
    assert_eq!(
        text_for_speech("完成啦 🎉 继续处理 👩🏽‍💻，保留中文和标点。"),
        "完成啦  继续处理 ，保留中文和标点。"
    );
}

#[test]
fn validates_generated_text_save_extensions() {
    assert!(validate_save_path(PathBuf::from("answer.md").as_path()).is_ok());
    assert!(validate_save_path(PathBuf::from("script.rs").as_path()).is_ok());
    assert!(validate_save_path(PathBuf::from("archive.zip").as_path()).is_err());
    assert!(validate_save_path(PathBuf::from("README").as_path()).is_err());
}

#[cfg(target_os = "macos")]
#[test]
fn keeps_macos_capture_coordinates_in_core_graphics_points() {
    assert_eq!(
        crate::screen_capture::capture_area_coordinates(
            PhysicalPosition::new(100, 200),
            &CaptureSelection {
                x: 10.0,
                y: 20.0,
                width: 300.0,
                height: 160.0,
            },
            2.0,
        ),
        (110, 220, 300, 160),
    );
}

#[test]
fn defaults_to_balanced_quiet_mode() {
    let settings = AppSettings::default();
    assert_eq!(settings.quiet_mode, "balanced");
    assert_eq!(settings.companion_name, "Piko");
    assert_eq!(settings.theme, "sage");
    assert!(!settings.sensing_paused);
    assert!(settings.break_reminders_enabled);
    assert_eq!(settings.break_reminder_interval_minutes, 45);
    assert_eq!(settings.break_reminder_cooldown_minutes, 30);
    assert!(!settings.break_reminder_quiet_hours_enabled);
    assert_eq!(settings.break_reminder_quiet_hours_start, "22:00");
    assert_eq!(settings.break_reminder_quiet_hours_end, "08:00");
}

#[test]
fn uses_quiet_mode_specific_idle_thresholds() {
    assert_eq!(idle_threshold_seconds("active"), 60);
    assert_eq!(idle_threshold_seconds("balanced"), 120);
    assert_eq!(idle_threshold_seconds("minimal"), 300);
}

#[test]
fn starts_and_ends_idle_rest_without_recording_input() {
    let settings = AppSettings::default();
    let (is_idle, event) = next_idle_state(false, &settings, 120, false);
    assert!(is_idle);
    assert!(matches!(
        event,
        Some(crate::runtime_types::PetVisualEvent::IdleStarted)
    ));

    let (is_idle, event) = next_idle_state(is_idle, &settings, 0, false);
    assert!(!is_idle);
    assert!(matches!(
        event,
        Some(crate::runtime_types::PetVisualEvent::IdleEnded)
    ));
}

#[test]
fn suppresses_idle_rest_while_sensing_is_paused_or_piko_is_busy() {
    let mut settings = AppSettings {
        sensing_paused: true,
        ..Default::default()
    };
    assert!(!next_idle_state(false, &settings, 120, false).0);

    settings.sensing_paused = false;
    assert!(!next_idle_state(false, &settings, 120, true).0);
}

#[test]
fn compares_release_version_parts() {
    assert!(version_parts("v0.2.0") > version_parts("0.1.9"));
    assert_eq!(version_parts("v1.0.0"), vec![1]);
}

#[test]
fn ollama_is_registered_as_openai_compatible_provider() {
    assert_eq!(
        provider_kind("ollama"),
        Some(ProviderKind::OpenAiCompatible)
    );
    assert!(is_local_provider("ollama"));

    let settings = AiSettings {
        provider: "ollama".to_string(),
        base_url: "http://localhost:11434/v1".to_string(),
        model: "".to_string(),
        ..Default::default()
    };
    assert!(validate_ai_settings(&settings).is_ok());
    assert_eq!(
        chat_url(&settings).unwrap(),
        "http://localhost:11434/v1/chat/completions"
    );
}

#[test]
fn openai_official_provider_uses_openai_compatible_protocol() {
    let settings = AiSettings {
        provider: "openai".to_string(),
        base_url: "https://api.openai.com/v1".to_string(),
        model: "gpt-4o".to_string(),
        ..Default::default()
    };
    assert_eq!(
        provider_kind("openai"),
        Some(ProviderKind::OpenAiCompatible)
    );
    assert!(validate_ai_settings(&settings).is_ok());
    assert_eq!(
        chat_url(&settings).unwrap(),
        "https://api.openai.com/v1/chat/completions"
    );
    assert_eq!(models_url(&settings), "https://api.openai.com/v1/models");
}

#[test]
fn extracts_openai_compatible_chat_delta() {
    assert_eq!(
        extract_chat_deltas(
            "openai-compatible",
            r#"data: {"choices":[{"delta":{"content":"你好"}}]}"#
        ),
        vec!["你好".to_string()]
    );
    assert!(extract_chat_deltas("openai-compatible", "data: [DONE]").is_empty());
}

#[test]
fn lmstudio_uses_openai_compatible_protocol() {
    let ai = AiSettings {
        provider: "lmstudio".to_string(),
        base_url: "http://localhost:1234/v1".to_string(),
        model: "llama-3.2-1b".to_string(),
        ..Default::default()
    };
    // LM Studio uses the same chat completions endpoint as OpenAI
    assert_eq!(
        chat_url(&ai).unwrap(),
        "http://localhost:1234/v1/chat/completions"
    );
    // LM Studio uses the same models listing endpoint
    assert_eq!(models_url(&ai), "http://localhost:1234/v1/models");
    // LM Studio model list response uses OpenAI-compatible "data" array
    assert_eq!(
        extract_model_ids(
            "lmstudio",
            &serde_json::json!({ "data": [{ "id": "llama-3.2-1b" }, { "id": "qwen2.5-7b" }] })
        ),
        vec!["llama-3.2-1b".to_string(), "qwen2.5-7b".to_string()]
    );
    // LM Studio streaming deltas use the same format as OpenAI
    assert_eq!(
        extract_chat_deltas(
            "lmstudio",
            r#"data: {"choices":[{"delta":{"content":"Hello from LM Studio"}}]}"#
        ),
        vec!["Hello from LM Studio".to_string()]
    );
    assert!(extract_chat_deltas("lmstudio", "data: [DONE]").is_empty());
    // LM Studio localhost should bypass system proxy
    assert!(should_bypass_system_proxy("http://localhost:1234/v1"));
}

#[test]
fn lmstudio_builds_openai_compatible_chat_request_body() {
    let settings = AppSettings {
        ai: AiSettings {
            provider: "lmstudio".to_string(),
            base_url: "http://localhost:1234/v1".to_string(),
            model: "llama-3.2-1b".to_string(),
            temperature: 0.5,
            ..Default::default()
        },
        ..Default::default()
    };
    let body = chat_request_body(&settings, &[], "你好", None, None, None).unwrap();
    // Same structure as OpenAI-compatible providers
    assert_eq!(body["model"], "llama-3.2-1b");
    assert_eq!(body["temperature"], 0.5);
    assert_eq!(body["stream"], true);
    assert_eq!(body["messages"][0]["role"], "system");
    assert_eq!(body["messages"][1]["role"], "user");
    assert_eq!(body["messages"][1]["content"], "你好");
}

#[test]
fn lmstudio_allows_empty_model_for_auto_detection() {
    // LM Studio auto-selects the currently loaded model when model is empty
    let settings = AiSettings {
        provider: "lmstudio".to_string(),
        base_url: "http://localhost:1234/v1".to_string(),
        model: "".to_string(),
        ..Default::default()
    };
    assert!(validate_ai_settings(&settings).is_ok());

    let openai_compatible = AiSettings {
        provider: "openai-compatible".to_string(),
        base_url: "http://localhost:11434/v1".to_string(),
        model: "".to_string(),
        ..Default::default()
    };
    assert!(validate_ai_settings(&openai_compatible).is_ok());

    // Cloud providers still require a model name
    let anthropic = AiSettings {
        provider: "anthropic".to_string(),
        base_url: "https://api.anthropic.com/v1".to_string(),
        model: "".to_string(),
        ..Default::default()
    };
    assert!(validate_ai_settings(&anthropic).is_err());

    // LM Studio with empty model should still build a valid request body
    let app_settings = AppSettings {
        ai: settings,
        ..Default::default()
    };
    let body = chat_request_body(&app_settings, &[], "你好", None, None, None).unwrap();
    assert_eq!(body["model"], "");
}

#[test]
fn builds_anthropic_and_gemini_multimodal_payloads() {
    let capture = ScreenCapture {
        data_url: "data:image/png;base64,cG5n".to_string(),
        width: 1,
        height: 1,
    };
    assert_eq!(
        parse_data_url(&capture.data_url).unwrap(),
        ("image/png", "cG5n")
    );

    let mut settings = AppSettings::default();
    settings.ai.provider = "anthropic".to_string();
    let anthropic = chat_request_body(&settings, &[], "看图", Some(&capture), None, None).unwrap();
    assert_eq!(
        anthropic["messages"][0]["content"][1]["source"]["data"],
        "cG5n"
    );

    settings.ai.provider = "gemini".to_string();
    let gemini = chat_request_body(&settings, &[], "看图", Some(&capture), None, None).unwrap();
    assert_eq!(
        gemini["contents"][0]["parts"][1]["inlineData"]["mimeType"],
        "image/png"
    );
}

#[test]
fn serializes_single_word_chat_event_types() {
    let json = serde_json::to_value(ChatEvent::Completed {
        request_id: "request-1".to_string(),
    })
    .expect("chat event should serialize");

    assert_eq!(json["type"], "completed");
    assert_eq!(json["requestId"], "request-1");
}

#[test]
fn serializes_action_proposed_chat_events_for_the_bubble_listener() {
    let json = serde_json::to_value(ChatEvent::ActionProposed {
        request_id: "request-1".to_string(),
        draft: crate::actions::ActionDraft {
            id: "draft-1".to_string(),
            plugin_id: "piko.calendar".to_string(),
            tool_name: "create_event".to_string(),
            summary: "创建日程".to_string(),
            arguments: serde_json::json!({}),
            created_at: 1,
        },
    })
    .expect("chat event should serialize");

    assert_eq!(json["type"], "action-proposed");
    assert_eq!(json["requestId"], "request-1");
    assert_eq!(json["draft"]["createdAt"], 1);
}

#[test]
fn system_prompt_mentions_reminder_and_calendar_lookup_for_deletion() {
    let prompt = system_prompt("Piko", None, None);
    assert!(prompt.contains("查询提醒时优先调用 list_reminders"));
    assert!(prompt.contains("查询、删除或定位日程时优先调用 list_events"));
    assert!(prompt.contains("删除提醒或日程前"));
    assert!(prompt.contains("删除多个或全部日程时必须使用 delete_event_batch"));
}

#[test]
fn detects_local_action_requests_that_require_tools() {
    assert!(prompt_requests_local_action("帮我创建明天下午 3 点的日程"));
    assert!(prompt_requests_local_action("delete this calendar event"));
    assert!(prompt_requests_local_action("设置一个喝水提醒"));
    assert!(prompt_requests_local_action("帮我记一下备忘：买牛奶"));
    assert!(prompt_requests_local_action("添加备忘：周五提交报告"));
    assert!(!prompt_requests_local_action("解释一下怎么规划日程"));
    assert!(!prompt_requests_local_action("今天适合做什么"));
}

#[test]
fn detects_unconfirmed_local_action_success_claims() {
    assert!(looks_like_unconfirmed_local_action_response(
        "已成功创建日程：项目评审"
    ));
    assert!(looks_like_unconfirmed_local_action_response(
        "Reminder deleted successfully."
    ));
    assert!(looks_like_unconfirmed_local_action_response(
        "好的，我已经帮你记到备忘录了 ✅"
    ));
    assert!(looks_like_unconfirmed_local_action_response(
        "已创建备忘：买牛奶"
    ));
    assert!(!looks_like_unconfirmed_local_action_response(
        "我可以帮你创建日程，但需要先确认。"
    ));
    assert!(!looks_like_unconfirmed_local_action_response(
        "这是一个普通回答。"
    ));
}

#[test]
fn prepares_a_text_attachment_preview_without_exposing_its_path() {
    let path = temp_attachment_path("md");
    fs::write(&path, "第一行\n第二行").expect("fixture should be writable");

    let (attachment, preview) =
        read_text_attachment(&path).expect("markdown attachment should be accepted");

    assert_eq!(attachment.content, "第一行\n第二行");
    assert_eq!(
        preview.display_name,
        path.file_name().unwrap().to_string_lossy()
    );
    assert_eq!(preview.char_count, 7);
    assert!(!preview
        .preview
        .contains(path.parent().unwrap().to_string_lossy().as_ref()));
    let _ = fs::remove_file(path);
}

#[test]
fn rejects_an_unsupported_attachment_extension() {
    let path = temp_attachment_path("png");
    fs::write(&path, "not really an image").expect("fixture should be writable");

    assert!(read_text_attachment(&path).is_err());
    let _ = fs::remove_file(path);
}

#[test]
fn rejects_an_attachment_larger_than_one_mibibyte() {
    let path = temp_attachment_path("txt");
    fs::write(&path, vec![b'a'; 1024 * 1024 + 1]).expect("fixture should be writable");

    assert!(read_text_attachment(&path).is_err());
    let _ = fs::remove_file(path);
}

#[test]
fn requires_an_explicit_action_before_including_attachment_content() {
    let attachment = TextAttachment {
        display_name: "notes.md".to_string(),
        content: "private body".to_string(),
    };

    let (plain_prompt, _) =
        build_attachment_prompt("hello", None, Some(&attachment)).expect("plain chat works");
    assert_eq!(plain_prompt, "hello");

    let (attachment_prompt, history_prompt) =
        build_attachment_prompt("", Some("summarize"), Some(&attachment))
            .expect("confirmed attachment action works");
    assert!(attachment_prompt.contains("private body"));
    assert_eq!(history_prompt, "[附件总结] notes.md");
}

#[test]
fn batch_delete_reads_unified_events_and_preserves_reminders() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("schedule-items.json");
    let items: Vec<crate::schedule::ScheduleItem> = serde_json::from_value(serde_json::json!([
        {"id":"r1","kind":"reminder","title":"提醒","startAt":100},
        {"id":"e1","kind":"event","title":"一","startAt":100,"endAt":200},
        {"id":"e2","kind":"event","title":"二","startAt":300,"endAt":400},
        {"id":"e3","kind":"event","title":"三","startAt":500,"endAt":600}
    ]))
    .unwrap();
    crate::storage::write(&path, &items).unwrap();
    let loaded: Vec<crate::schedule::ScheduleItem> = crate::storage::read(&path).unwrap();
    let mut events = crate::schedule::calendar_view(&loaded);
    let before = serde_json::to_value(&events).unwrap();
    let missing =
        crate::calendar_service::calendar_delete_batch_input_from_value(&serde_json::json!({
            "events":[{"id":"e1"},{"id":"missing"}]
        }))
        .unwrap();
    assert!(crate::calendar_service::remove_calendar_event_batch(&mut events, missing).is_err());
    assert_eq!(serde_json::to_value(&events).unwrap(), before);
    let input =
        crate::calendar_service::calendar_delete_batch_input_from_value(&serde_json::json!({
            "events":[{"id":"e1"},{"id":"e2"},{"id":"e3"}]
        }))
        .unwrap();
    assert_eq!(
        crate::calendar_service::remove_calendar_event_batch(&mut events, input)
            .unwrap()
            .len(),
        3
    );
    crate::storage::write(
        &path,
        &crate::schedule::merge_calendar_events(&loaded, &events),
    )
    .unwrap();
    let after: Vec<crate::schedule::ScheduleItem> = crate::storage::read(&path).unwrap();
    assert!(crate::schedule::calendar_view(&after).is_empty());
    assert_eq!(crate::schedule::reminders_view(&after)[0].id, "r1");
}

#[test]
fn calendar_lifecycle_roundtrip_keeps_reminders_and_selected_event_identity() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("schedule-items.json");
    let initial: Vec<crate::schedule::ScheduleItem> = serde_json::from_value(serde_json::json!([
        {"id":"r1","kind":"reminder","title":"不得删除的提醒","startAt":1792130400}
    ]))
    .unwrap();
    let reminder_before = serde_json::to_value(&initial[0]).unwrap();
    let start_at = crate::common::unix_timestamp() + 24 * 60 * 60;
    let events = ["回归-评审", "回归-取消验证"]
        .into_iter()
        .map(|title| {
            crate::calendar_service::calendar_event_from_input(
                crate::calendar_service::CalendarEventInput {
                    title: title.into(),
                    start_at,
                    end_at: start_at + 3600,
                    location: Some("测试会议室".into()),
                    notes: Some("持久化回归".into()),
                },
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    assert_ne!(events[0].id, events[1].id);
    crate::storage::write(
        &path,
        &crate::schedule::merge_calendar_events(&initial, &events),
    )
    .unwrap();
    let reloaded: Vec<crate::schedule::ScheduleItem> = crate::storage::read(&path).unwrap();
    let mut remaining = crate::schedule::calendar_view(&reloaded);
    assert_eq!(remaining, events, "重新读取必须保留 ID、日期、地点和备注");
    let arguments = serde_json::to_value(&remaining).unwrap();
    let selected =
        crate::actions::selection::selected_calendar_batch_events(&arguments, Some(vec![1]))
            .unwrap();
    let input = crate::calendar_service::calendar_delete_batch_input_from_value(
        &serde_json::json!({"events":selected}),
    )
    .unwrap();
    assert_eq!(
        crate::calendar_service::remove_calendar_event_batch(&mut remaining, input).unwrap(),
        vec![events[1].clone()]
    );
    crate::storage::write(
        &path,
        &crate::schedule::merge_calendar_events(&reloaded, &remaining),
    )
    .unwrap();
    let reloaded: Vec<crate::schedule::ScheduleItem> = crate::storage::read(&path).unwrap();
    assert_eq!(
        crate::schedule::calendar_view(&reloaded),
        vec![events[0].clone()]
    );
    assert_eq!(serde_json::to_value(&reloaded[0]).unwrap(), reminder_before);
    let mut remaining = crate::schedule::calendar_view(&reloaded);
    let input =
        crate::calendar_service::calendar_delete_batch_input_from_value(&serde_json::json!({
            "events": [{"id":events[0].id}]
        }))
        .unwrap();
    crate::calendar_service::remove_calendar_event_batch(&mut remaining, input).unwrap();
    crate::storage::write(
        &path,
        &crate::schedule::merge_calendar_events(&reloaded, &remaining),
    )
    .unwrap();
    let final_items: Vec<crate::schedule::ScheduleItem> = crate::storage::read(&path).unwrap();
    assert!(crate::schedule::calendar_view(&final_items).is_empty());
    assert_eq!(
        serde_json::to_value(&final_items).unwrap(),
        serde_json::to_value(&initial).unwrap()
    );
}

#[test]
fn batch_delete_respects_selected_targets_and_rejects_empty_or_duplicate_choices() {
    let events = serde_json::json!([{"id":"e1"},{"id":"e2"},{"id":"e3"}]);
    assert_eq!(
        crate::actions::selection::selected_calendar_batch_events(&events, Some(vec![1])).unwrap(),
        serde_json::json!([{"id":"e2"}])
    );
    assert_eq!(
        crate::actions::selection::selected_calendar_batch_events(&events, None).unwrap(),
        events
    );
    assert!(
        crate::actions::selection::selected_calendar_batch_events(&events, Some(vec![])).is_err()
    );
    assert!(
        crate::actions::selection::selected_calendar_batch_events(&events, Some(vec![1, 1]))
            .is_err()
    );
    assert!(
        crate::actions::selection::selected_calendar_batch_events(&events, Some(vec![3])).is_err()
    );
}

#[test]
fn calendar_query_tools_return_exact_iso_times_and_preserve_ids() {
    let event = crate::calendar_service::CalendarEvent {
        id: "test-calendar-id".into(),
        title: "评审".into(),
        start_at: 1792044000,
        end_at: 1792047600,
        location: Some("回归测试会议室".into()),
        notes: None,
    };
    let result = crate::plugins::calendar_events_tool_result(&[event]).unwrap();
    assert_eq!(result[0]["id"], "test-calendar-id");
    let start =
        chrono::DateTime::parse_from_rfc3339(result[0]["startAt"].as_str().unwrap()).unwrap();
    let end = chrono::DateTime::parse_from_rfc3339(result[0]["endAt"].as_str().unwrap()).unwrap();
    assert_eq!(start.timestamp(), 1792044000);
    assert_eq!(end.timestamp(), 1792047600);
    assert_eq!(end.signed_duration_since(start).num_minutes(), 60);
    assert_eq!(result[0]["location"], "回归测试会议室");
    assert_eq!(
        crate::plugins::calendar_events_tool_result(&[]).unwrap(),
        serde_json::json!([])
    );
}

#[test]
fn injects_tools_for_all_native_tool_use_providers() {
    let manifests = PluginRegistry::with_builtin_plugins().manifests();
    let mut openai = serde_json::json!({ "messages": [] });
    let mut anthropic = serde_json::json!({ "messages": [] });
    let mut gemini = serde_json::json!({ "contents": [] });

    append_provider_tools(&mut openai, "openai-compatible", &manifests);
    append_provider_tools(&mut anthropic, "anthropic", &manifests);
    append_provider_tools(&mut gemini, "gemini", &manifests);

    assert!(openai["tools"].is_array());
    assert!(anthropic["tools"].is_array());
    assert!(gemini["tools"][0]["functionDeclarations"].is_array());
}

#[test]
fn coalesces_multiple_calendar_delete_calls_into_one_batch() {
    let calls = vec![
        (
            "call-1".to_string(),
            ToolCall {
                plugin_id: "piko.calendar".to_string(),
                tool_name: "delete_event".to_string(),
                arguments: serde_json::json!({ "id": "event-1", "title": "日程一" }),
            },
        ),
        (
            "call-2".to_string(),
            ToolCall {
                plugin_id: "piko.calendar".to_string(),
                tool_name: "delete_event".to_string(),
                arguments: serde_json::json!({ "id": "event-2", "title": "日程二" }),
            },
        ),
    ];

    let coalesced = coalesce_calendar_delete_calls(calls);

    assert_eq!(coalesced.len(), 1);
    assert_eq!(coalesced[0].1.tool_name, "delete_event_batch");
    assert_eq!(
        coalesced[0].1.arguments["events"].as_array().unwrap().len(),
        2
    );
}

#[test]
fn builds_batch_calendar_confirmation_drafts() {
    let batch = serde_json::json!({
        "events": [
            {
                "title": "学习一",
                "startAt": "2026-06-02T15:00:00+08:00",
                "endAt": "2026-06-02T16:00:00+08:00"
            },
            {
                "title": "学习二",
                "startAt": "2026-06-03T15:00:00+08:00",
                "endAt": "2026-06-03T16:00:00+08:00"
            }
        ]
    });
    assert_eq!(
        calendar_event_batch_input_from_value(&batch)
            .unwrap()
            .events
            .len(),
        2
    );
    let draft = action_draft_from_tool_call(
        &ToolCall {
            plugin_id: "piko.calendar".to_string(),
            tool_name: "create_event_batch".to_string(),
            arguments: batch,
        },
        Local::now(),
    )
    .unwrap();
    assert!(draft.summary.contains("批量创建 2 条日程"));
}

#[test]
fn weekdays_skip_weekends() {
    let friday = chrono::Local
        .with_ymd_and_hms(2026, 9, 25, 7, 0, 0)
        .unwrap()
        .timestamp() as u64;
    let monday = chrono::Local
        .with_ymd_and_hms(2026, 9, 28, 7, 0, 0)
        .unwrap()
        .timestamp() as u64;
    assert_eq!(next_repeat_due(friday, "weekdays", friday), monday);
}

#[test]
fn session_chat_history_is_limited_to_ten_entries() {
    let mut history = Vec::new();
    for index in 0..12 {
        append_session_chat_history(
            &mut history,
            ChatHistoryEntry {
                conversation_id: None,
                id: index.to_string(),
                prompt: index.to_string(),
                response: index.to_string(),
                created_at: index,
            },
        );
    }

    assert_eq!(history.len(), 10);
    assert_eq!(history[0].id, "11");
    assert_eq!(history[9].id, "2");
}

fn temp_attachment_path(extension: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "piko-attachment-{}-{}.{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        extension
    ))
}
