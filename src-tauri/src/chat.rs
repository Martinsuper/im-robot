//! Model payloads, streaming and chat command handling.
use super::*;

pub(super) fn extract_model_ids(provider: &str, body: &Value) -> Vec<String> {
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

pub(super) fn system_prompt(companion_name: &str, memory_context: Option<&str>) -> String {
    let now = Local::now();
    let base = format!(
        "你是桌面 AI 宠物精灵 {companion_name}。回答应清晰、简洁、友好。当前本地时间是 {}。可以使用已提供的工具读取、创建、检查冲突，或提出提醒、日程和备忘录草稿。用户说“记一下”“帮我记”“添加备忘”且没有明确提醒时间时，优先调用 create_memo；如果包含提醒时间，优先调用 create_reminder。查询提醒时优先调用 list_reminders；查询备忘录时优先调用 list_memos；查询、删除或定位日程时优先调用 list_events。删除提醒或日程前，先用列表工具找到具体目标，再生成待确认草稿并等待用户确认。删除多个或全部日程时必须使用 delete_event_batch，一次提交全部目标 ID。规划多条日程时优先使用批量创建工具。工具中的时间参数必须使用带时区的 ISO 8601 字符串，例如 2026-06-02T15:00:00+08:00，不要自行计算 Unix 时间戳。写入和删除操作必须等待用户确认；不要声称已经执行未实际执行的电脑操作。遇到时间歧义时先向用户追问。",
        now.format("%Y-%m-%d %H:%M:%S %:z")
    );

    match memory_context {
        Some(ctx) if !ctx.is_empty() => {
            format!(
                "{}\n\n--- 长期记忆上下文 ---\n{}\n--- 记忆结束 ---",
                base, ctx
            )
        }
        _ => base,
    }
}

pub(super) fn prompt_requests_local_action(prompt: &str) -> bool {
    let normalized = prompt.to_lowercase();
    let has_local_target = ["提醒", "日程", "备忘", "calendar", "reminder", "memo"]
        .iter()
        .any(|term| normalized.contains(term));
    let has_mutation = [
        "创建",
        "新增",
        "添加",
        "设置",
        "安排",
        "删除",
        "移除",
        "取消",
        "记一下",
        "帮我记",
        "记下",
        "记到",
        "create",
        "add",
        "set",
        "schedule",
        "delete",
        "remove",
        "cancel",
    ]
    .iter()
    .any(|term| normalized.contains(term));

    has_local_target && has_mutation
}

pub(super) fn looks_like_unconfirmed_local_action_response(response: &str) -> bool {
    let normalized = response.to_lowercase();
    let has_local_target = ["提醒", "日程", "备忘", "calendar", "reminder", "memo"]
        .iter()
        .any(|term| normalized.contains(term));
    let has_mutation = [
        "创建", "新增", "添加", "设置", "安排", "删除", "移除", "取消", "记下", "记到", "create",
        "add", "set", "schedule", "delete", "remove", "cancel",
    ]
    .iter()
    .any(|term| normalized.contains(term));
    let claims_success = [
        "已",
        "成功",
        "完成",
        "created",
        "scheduled",
        "deleted",
        "removed",
        "done",
    ]
    .iter()
    .any(|term| normalized.contains(term));

    has_local_target && has_mutation && claims_success
}

pub(super) fn openai_user_content(prompt: &str, screenshot: Option<&ScreenCapture>) -> Value {
    if let Some(screenshot) = screenshot {
        json!([
            { "type": "text", "text": prompt.trim() },
            { "type": "image_url", "image_url": { "url": screenshot.data_url } }
        ])
    } else {
        json!(prompt.trim())
    }
}

pub(super) fn anthropic_user_content(
    prompt: &str,
    screenshot: Option<&ScreenCapture>,
) -> Result<Value, String> {
    if let Some(screenshot) = screenshot {
        let (media_type, data) = parse_data_url(&screenshot.data_url)?;
        Ok(json!([
            { "type": "text", "text": prompt.trim() },
            { "type": "image", "source": { "type": "base64", "media_type": media_type, "data": data } }
        ]))
    } else {
        Ok(json!(prompt.trim()))
    }
}

pub(super) fn gemini_user_parts(
    prompt: &str,
    screenshot: Option<&ScreenCapture>,
) -> Result<Value, String> {
    let mut parts = vec![json!({ "text": prompt.trim() })];
    if let Some(screenshot) = screenshot {
        let (mime_type, data) = parse_data_url(&screenshot.data_url)?;
        parts.push(json!({ "inlineData": { "mimeType": mime_type, "data": data } }));
    }
    Ok(Value::Array(parts))
}

pub(super) fn chat_request_body(
    settings: &AppSettings,
    recent_history: &[ChatHistoryEntry],
    prompt: &str,
    screenshot: Option<&ScreenCapture>,
    memory_context: Option<&str>,
) -> Result<Value, String> {
    match provider_kind(&settings.ai.provider) {
        Some(ProviderKind::OpenAiCompatible) => {
            let mut messages = vec![json!({
                "role": "system",
                "content": system_prompt(&settings.companion_name, memory_context)
            })];
            for entry in recent_history.iter().take(10).rev() {
                messages.push(json!({ "role": "user", "content": entry.prompt }));
                messages.push(json!({ "role": "assistant", "content": entry.response }));
            }
            messages.push(
                json!({ "role": "user", "content": openai_user_content(prompt, screenshot) }),
            );
            Ok(json!({
                "model": settings.ai.model,
                "messages": messages,
                "temperature": settings.ai.temperature,
                "stream": true
            }))
        }
        Some(ProviderKind::Anthropic) => {
            let mut messages = Vec::new();
            for entry in recent_history.iter().take(10).rev() {
                messages.push(json!({ "role": "user", "content": entry.prompt }));
                messages.push(json!({ "role": "assistant", "content": entry.response }));
            }
            messages.push(
                json!({ "role": "user", "content": anthropic_user_content(prompt, screenshot)? }),
            );
            Ok(json!({
                "model": settings.ai.model,
                "system": system_prompt(&settings.companion_name, memory_context),
                "messages": messages,
                "temperature": settings.ai.temperature,
                "max_tokens": 4096,
                "stream": true
            }))
        }
        Some(ProviderKind::Gemini) => {
            let mut contents = Vec::new();
            for entry in recent_history.iter().take(10).rev() {
                contents.push(json!({ "role": "user", "parts": [{ "text": entry.prompt }] }));
                contents.push(json!({ "role": "model", "parts": [{ "text": entry.response }] }));
            }
            contents
                .push(json!({ "role": "user", "parts": gemini_user_parts(prompt, screenshot)? }));
            Ok(json!({
                "systemInstruction": { "parts": [{ "text": system_prompt(&settings.companion_name, memory_context) }] },
                "contents": contents,
                "generationConfig": { "temperature": settings.ai.temperature }
            }))
        }
        None => Err("不支持的模型服务类型".to_string()),
    }
}

pub(super) fn pet_companion_generation_url(settings: &AiSettings) -> Result<String, String> {
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

pub(super) fn pet_companion_generation_system_prompt(companion_name: &str) -> String {
    format!(
        "你是桌面宠物 {companion_name} 的语言与动作节奏助手。你必须只输出严格 JSON，不要 Markdown，不要解释，不要代码块。\
返回对象字段如下：message(string，可选但在 dialogue 模式下必须提供)、motionStyle(string，必须是 soft/balanced/lively 之一，可选但在 idleProfile 模式下必须提供)、behaviorProfile(string，必须是 calm/balanced/playful/curious/focused 之一，可选但在 behaviorProfile 模式下必须提供)、behaviorPriority(array[string]，元素必须是 calm/balanced/playful/curious/focused/neutral 之一，可选但在 behaviorPriority 模式下必须提供)。\
message 必须是自然、简短、中文、像宠物对用户说的话，避免模板味。motionStyle 的含义是：soft=更安静更轻缓，balanced=均衡，lively=更活跃更靠近。"
    )
}

pub(super) fn pet_companion_generation_user_prompt(input: &PetCompanionGenerationInput) -> String {
    let context = input.context.as_deref().unwrap_or("无额外上下文");
    let interaction_type = input.interaction_type.as_deref().unwrap_or("none");
    let personality_summary = input
        .personality_summary
        .as_deref()
        .unwrap_or("无额外人格描述");
    format!(
        "请为桌面宠物生成响应。\
mode: {}\
scene: {}\
bondTier: {}\
interactionType: {}\
personality: {{\"energy\": {}, \"humor\": {}, \"curiosity\": {}}}\
personalitySummary: {}\
context: {}\
\
规则：\
1. 只返回 JSON 对象。\
2. dialogue 模式下优先给出 message。\
3. idleProfile 模式下优先给出 motionStyle。\
4. behaviorProfile 模式下优先给出 behaviorProfile。\
5. behaviorPriority 模式下优先给出 behaviorPriority。\
6. 内容要自然，不要像说明书。\
7. 不要输出多余字段。",
        input.mode,
        input.scene,
        input.bond_tier,
        interaction_type,
        input.personality.energy,
        input.personality.humor,
        input.personality.curiosity,
        personality_summary,
        context
    )
}

pub(super) fn extract_completion_text(provider: &str, body: &Value) -> Option<String> {
    match provider_kind(provider) {
        Some(ProviderKind::Anthropic) => {
            let joined = body["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|item| item["text"].as_str())
                .collect::<Vec<_>>()
                .join("");
            let trimmed = joined.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Some(ProviderKind::Gemini) => {
            let joined = body["candidates"][0]["content"]["parts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|part| part["text"].as_str())
                .collect::<Vec<_>>()
                .join("");
            let trimmed = joined.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        _ => body["choices"][0]["message"]["content"]
            .as_str()
            .map(str::trim)
            .map(str::to_string)
            .or_else(|| {
                body["choices"][0]["message"]["content"]
                    .as_array()
                    .and_then(|parts| {
                        let mut joined = String::new();
                        for part in parts {
                            if let Some(text) = part["text"].as_str() {
                                joined.push_str(text);
                            }
                        }
                        let trimmed = joined.trim().to_string();
                        if trimmed.is_empty() {
                            None
                        } else {
                            Some(trimmed)
                        }
                    })
            }),
    }
}

pub(super) fn extract_json_fragment(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end <= start {
        return None;
    }
    Some(&text[start..=end])
}

pub(super) fn parse_pet_companion_generation_output(
    provider: &str,
    body: &Value,
) -> Result<PetCompanionGenerationOutput, String> {
    let raw_text = extract_completion_text(provider, body)
        .ok_or_else(|| "模型没有返回有效内容".to_string())?;
    let trimmed = raw_text.trim();
    let fragment = extract_json_fragment(trimmed).unwrap_or(trimmed);
    let parsed: Value = serde_json::from_str(fragment)
        .map_err(|error| format!("模型返回的 JSON 无法解析：{error}"))?;

    let message = parsed["message"]
        .as_str()
        .map(|value| value.trim().to_string());
    let motion_style = parsed["motionStyle"]
        .as_str()
        .and_then(|value| match value.trim() {
            "soft" | "balanced" | "lively" => Some(value.trim().to_string()),
            _ => None,
        });
    let behavior_profile =
        parsed["behaviorProfile"]
            .as_str()
            .and_then(|value| match value.trim() {
                "calm" | "balanced" | "playful" | "curious" | "focused" => {
                    Some(value.trim().to_string())
                }
                _ => None,
            });
    let behavior_priority = parsed["behaviorPriority"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(str::trim)
                .filter(|value| {
                    matches!(
                        *value,
                        "calm" | "balanced" | "playful" | "curious" | "focused" | "neutral"
                    )
                })
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|items| !items.is_empty());

    Ok(PetCompanionGenerationOutput {
        message,
        motion_style,
        behavior_profile,
        behavior_priority,
    })
}

pub(super) fn extract_chat_deltas(provider: &str, line: &str) -> Vec<String> {
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

pub(super) fn emit_chat_event(app: &AppHandle, event: ChatEvent) {
    let _ = app.emit_to("bubble", "chat-event", event.clone());
    let _ = app.emit_to("pet", "chat-event", event);
}

pub(super) async fn send_chat_request(
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

struct StreamChatInput<'a> {
    request_id: &'a str,
    prompt: &'a str,
    history_prompt: &'a str,
    screenshot: Option<&'a ScreenCapture>,
    working: bool,
    cancelled: &'a CancellationToken,
}

async fn stream_chat(
    app: &AppHandle,
    context: &ChatContext,
    registry: &PluginRegistry,
    drafts: &ActionDrafts,
    memory_db: &memory::MemoryDb,
    cache: &memory::CandidateCache,
    input: StreamChatInput<'_>,
) -> Result<StreamChatOutcome, String> {
    let StreamChatInput {
        request_id,
        prompt,
        history_prompt,
        screenshot,
        working,
        cancelled,
    } = input;
    let settings = read_settings(app);
    validate_ai_settings(&settings.ai)?;
    if prompt.trim().is_empty() {
        return Err("问题不能为空".to_string());
    }

    emit_chat_event(
        app,
        ChatEvent::Started {
            request_id: request_id.to_string(),
            working,
        },
    );

    let client = http_client(&settings.ai)?;
    let recent_history = context
        .0
        .lock()
        .map_err(|_| "无法读取当前对话上下文".to_string())?
        .clone();

    // Build memory context from relevant long-term memories
    let memory_context_text = memory_db
        .build_context(memory::BuildContextInput {
            current_query: Some(prompt.to_string()),
            window_type: None,
            limit: Some(10),
        })
        .ok()
        .map(|memories| {
            memories
                .iter()
                .map(|m| format!("- [{}] {}: {}", m.memory_type.label(), m.title, m.content))
                .collect::<Vec<_>>()
                .join("\n")
        });

    let mut request_body = chat_request_body(
        &settings,
        &recent_history,
        prompt,
        screenshot,
        memory_context_text.as_deref(),
    )?;
    append_provider_tools(
        &mut request_body,
        &settings.ai.provider,
        &registry.manifests(),
    );
    let mut assistant_response = String::new();
    let mut sequence = 0;

    for tool_round in 0..=4 {
        let response = match tokio::select! { biased; _ = cancelled.cancelled() => return Ok(StreamChatOutcome::Cancelled), result = send_chat_request(&client, &settings.ai, &request_body) => result }
        {
            Ok(response) => response,
            Err(_) if tool_round == 0 && request_body.get("tools").is_some() => {
                if prompt_requests_local_action(prompt) {
                    return Err(
                        "当前模型服务没有接受工具调用，不能安全创建或删除日程/提醒。请换用支持工具调用的模型服务后重试。"
                            .to_string(),
                    );
                }
                request_body
                    .as_object_mut()
                    .ok_or_else(|| "模型请求格式无效".to_string())?
                    .remove("tools");
                tokio::select! { biased; _ = cancelled.cancelled() => return Ok(StreamChatOutcome::Cancelled), result = send_chat_request(&client, &settings.ai, &request_body) => result }?
            }
            Err(error) => return Err(error),
        };
        let mut response = response;
        let mut buffer = chat_stream::SseLines::default();
        let mut openai_tool_calls = Vec::new();

        while let Some(chunk) = tokio::select! { biased; _ = cancelled.cancelled() => return Ok(StreamChatOutcome::Cancelled), result = response.chunk() => result }.map_err(|error| error.to_string())? {
            if cancelled.is_cancelled() {
                return Ok(StreamChatOutcome::Cancelled);
            }
            for line in buffer.push(&chunk)? {
                let line = line.trim();
                update_provider_tool_calls(&settings.ai.provider, line, &mut openai_tool_calls);
                for text in extract_chat_deltas(&settings.ai.provider, line) {
                    assistant_response.push_str(&text);
                    sequence += 1;
                    emit_chat_event(
                        app,
                        ChatEvent::Delta {
                            request_id: request_id.to_string(),
                            sequence,
                            text,
                        },
                    );
                }
            }
        }
        let tail = buffer.finish()?;
        update_provider_tool_calls(&settings.ai.provider, tail.trim(), &mut openai_tool_calls);
        for text in extract_chat_deltas(&settings.ai.provider, tail.trim()) {
            assistant_response.push_str(&text);
            sequence += 1;
            emit_chat_event(
                app,
                ChatEvent::Delta {
                    request_id: request_id.to_string(),
                    sequence,
                    text,
                },
            );
        }

        if openai_tool_calls.is_empty() {
            if looks_like_unconfirmed_local_action_response(&assistant_response) {
                return Err(
                    "模型没有返回可执行的工具调用，因此不会创建或删除日程/提醒。请重试，或换用支持工具调用的模型。"
                        .to_string(),
                );
            }
            break;
        }
        if tool_round == 4 {
            return Err("模型工具调用次数过多".to_string());
        }

        let calls =
            coalesce_calendar_delete_calls(decode_openai_tool_calls(registry, openai_tool_calls)?);
        let mut tool_results = Vec::new();
        for (id, call) in calls {
            let manifest = registry.tool_manifest(&call)?;
            if manifest.confirmation != "never"
                || matches!(manifest.risk.as_str(), "write" | "sensitive")
            {
                let draft = action_draft_from_tool_call(&call, Local::now())?;
                drafts
                    .0
                    .lock()
                    .map_err(|_| "无法保存待确认动作".to_string())?
                    .insert(draft.id.clone(), draft.clone());
                emit_chat_event(
                    app,
                    ChatEvent::ActionProposed {
                        request_id: request_id.to_string(),
                        draft,
                    },
                );
                return Ok(StreamChatOutcome::ActionProposed);
            }
            let result = registry.execute(app, call.clone())?;
            tool_results.push((id, call, result));
        }
        append_provider_tool_results(&mut request_body, &settings.ai.provider, &tool_results)?;
    }

    let history_entry = ChatHistoryEntry {
        id: request_id.to_string(),
        prompt: history_prompt.to_string(),
        response: assistant_response,
        created_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };
    append_chat_history(app, history_entry.clone())?;
    let mut session_history = context
        .0
        .lock()
        .map_err(|_| "无法更新当前对话上下文".to_string())?;
    append_session_chat_history(&mut session_history, history_entry.clone());
    let _ = app.emit_to("panel", "chat-history-updated", ());

    if cancelled.is_cancelled() {
        return Ok(StreamChatOutcome::Cancelled);
    }

    emit_chat_event(
        app,
        ChatEvent::Completed {
            request_id: request_id.to_string(),
        },
    );
    let (confirmed_count, pending_count) = match memory::auto_capture_from_chat(
        memory_db,
        cache,
        &history_entry.prompt,
        &history_entry.response,
    ) {
        Ok(counts) => counts,
        Err(error) => {
            eprintln!("memory capture failed: {error}");
            (0, 0)
        }
    };

    if confirmed_count > 0 || pending_count > 0 {
        let _ = app.emit(
            "memory-captured",
            &MemoryCapturedEvent {
                confirmed: confirmed_count,
                pending: pending_count,
            },
        );
    }

    Ok(StreamChatOutcome::Completed)
}

pub(super) fn build_attachment_prompt(
    prompt: &str,
    attachment_action: Option<&str>,
    attachment: Option<&TextAttachment>,
) -> Result<(String, String), String> {
    let prompt = prompt.trim();
    let Some(action) = attachment_action else {
        if prompt.is_empty() {
            return Err("问题不能为空".to_string());
        }
        return Ok((prompt.to_string(), prompt.to_string()));
    };
    let attachment = attachment.ok_or_else(|| "请先拖入一个文本文件".to_string())?;
    let instruction = match action {
        "summarize" => "请总结附件内容，先给出要点，再给出简短结论。",
        "translate" => "请将附件内容翻译成中文；如果原文已经是中文，则翻译成英文。",
        "explain" => "请解释附件内容，指出结构、关键概念和需要注意的地方。",
        _ => return Err("不支持的附件处理动作".to_string()),
    };
    let user_note = if prompt.is_empty() {
        String::new()
    } else {
        format!("\n\n用户补充要求：{prompt}")
    };
    Ok((
        format!(
            "{instruction}\n\n附件名称：{}\n\n附件正文：\n{}{}",
            attachment.display_name, attachment.content, user_note
        ),
        format!(
            "[附件{}] {}",
            attachment_action_label(action),
            attachment.display_name
        ),
    ))
}

pub(super) fn attachment_action_label(action: &str) -> &str {
    match action {
        "summarize" => "总结",
        "translate" => "翻译",
        "explain" => "解释",
        _ => "处理",
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(super) async fn chat_start(
    app: AppHandle,
    requests: State<'_, ChatRequests>,
    context: State<'_, ChatContext>,
    drafts: State<'_, ActionDrafts>,
    attachments: State<'_, TextAttachmentStore>,
    captures: State<'_, ScreenCaptureStore>,
    memory_db: State<'_, memory::MemoryDb>,
    cache: State<'_, memory::CandidateCache>,
    input: ChatStartInput,
) -> Result<(), String> {
    let attachment = attachments
        .0
        .lock()
        .map_err(|_| "无法读取附件状态".to_string())?
        .clone();
    let prompt = if input.include_screenshot.unwrap_or(false) && input.prompt.trim().is_empty() {
        "请描述截图中的内容，并指出值得注意的信息。"
    } else {
        &input.prompt
    };
    let (model_prompt, history_prompt) = build_attachment_prompt(
        prompt,
        input.attachment_action.as_deref(),
        attachment.as_ref(),
    )?;
    let screenshot = if input.include_screenshot.unwrap_or(false) {
        captures
            .0
            .lock()
            .map_err(|_| "无法读取截图状态".to_string())?
            .clone()
            .ok_or_else(|| "请先框选截图区域".to_string())?
            .into()
    } else {
        None
    };
    let history_prompt = if screenshot.is_some() {
        format!("[截图] {history_prompt}")
    } else {
        history_prompt
    };
    let working = input.attachment_action.is_some() || screenshot.is_some();
    let cancelled = CancellationToken::new();
    requests
        .0
        .lock()
        .map_err(|_| "无法记录当前生成任务".to_string())?
        .insert(input.request_id.clone(), cancelled.clone());

    let registry = app.state::<PluginRegistry>();
    let result = stream_chat(
        &app,
        &context,
        &registry,
        &drafts,
        &memory_db,
        &cache,
        StreamChatInput {
            request_id: &input.request_id,
            prompt: &model_prompt,
            history_prompt: &history_prompt,
            screenshot: screenshot.as_ref(),
            working,
            cancelled: &cancelled,
        },
    )
    .await;
    if let Ok(mut active) = requests.0.lock() {
        active.remove(&input.request_id);
    }

    if matches!(result, Ok(StreamChatOutcome::Cancelled)) {
        emit_chat_event(
            &app,
            ChatEvent::Cancelled {
                request_id: input.request_id.clone(),
            },
        );
    }
    if let Err(message) = &result {
        emit_chat_event(
            &app,
            ChatEvent::Failed {
                request_id: input.request_id,
                message: message.clone(),
            },
        );
    }
    result.map(|_| ())
}

#[tauri::command]
pub(super) fn chat_cancel(
    requests: State<'_, ChatRequests>,
    request_id: String,
) -> Result<(), String> {
    if let Some(cancelled) = requests
        .0
        .lock()
        .map_err(|_| "无法读取当前生成任务".to_string())?
        .get(&request_id)
    {
        cancelled.cancel();
    }
    Ok(())
}

// ============================================================================
// ONBOARDING COMMANDS
// ============================================================================
