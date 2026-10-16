//! Owns the local Pi SDK process. Secrets only cross its private stdin pipe.
#[path = "agent_diagnostics.rs"]
mod diagnostics;
#[path = "agent_journal.rs"]
mod journal;
use journal::TaskJournal;

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::{path::PathBuf, process::Stdio, sync::Arc};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, Command},
    sync::Mutex,
};

// Includes time spent waiting for user confirmation. Expiry never retries a write.
const AGENT_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10 * 60);
const AGENT_TASK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30 * 60);
const TIMEOUT_MESSAGE: &str =
    "任务等待过久，已停止。此前可能已有部分操作完成，请检查结果后再决定是否重试。";

async fn next_agent_line<R: AsyncBufRead + Unpin>(
    lines: &mut Lines<R>,
    deadline: tokio::time::Instant,
    idle_timeout: std::time::Duration,
) -> Result<Option<String>, String> {
    let until = deadline.min(tokio::time::Instant::now() + idle_timeout);
    tokio::time::timeout_at(until, lines.next_line())
        .await
        .map_err(|_| TIMEOUT_MESSAGE.to_string())?
        .map_err(|_| "Agent 通信中断。此前可能已有部分操作完成，请检查结果。".to_string())
}

#[derive(Default)]
pub struct AgentRuntime(Mutex<Option<RunningTask>>);

struct RunningTask {
    request_id: String,
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    pending_actions: Arc<Mutex<HashMap<String, String>>>,
    workspace_call: Option<String>,
    read_only: bool,
    resuming: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStartInput {
    request_id: String,
    conversation_id: String,
    cwd: Option<String>,
    prompt: String,
    #[serde(default)]
    unified: bool,
    #[serde(default)]
    import_history: bool,
    attachment_action: Option<String>,
    include_screenshot: Option<bool>,
    verification_of: Option<String>,
    resume_of: Option<String>,
}

fn verify_entities(tool: &str, result: &Value, current: &Value) -> bool {
    let expected = result
        .as_array()
        .cloned()
        .unwrap_or_else(|| vec![result.clone()]);
    let Some(current) = current.as_array() else {
        return false;
    };
    !expected.is_empty()
        && expected.iter().all(|item| {
            let Some(id) = item.get("id").and_then(Value::as_str) else {
                return false;
            };
            if tool.starts_with("delete_") {
                !current
                    .iter()
                    .any(|stored| stored["id"].as_str() == Some(id))
            } else {
                current.iter().any(|stored| stored == item)
            }
        })
}

fn verification_tool_allowed(risk: &str, confirmation: &str) -> bool {
    risk == "read" && confirmation == "never"
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn runtime_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    if cfg!(debug_assertions) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let host = include_str!(concat!(env!("OUT_DIR"), "/agent-target.txt")).trim();
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        return Ok((
            root.join("binaries")
                .join(format!("piko-agent-node-{host}{suffix}")),
            root.join("agent-runtime"),
        ));
    }
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let node = executable
        .parent()
        .ok_or("无法定位 Agent 运行时")?
        .join(if cfg!(windows) {
            "piko-agent-node.exe"
        } else {
            "piko-agent-node"
        });
    let resources = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("agent-runtime");
    Ok((node, resources))
}

fn emit(app: &AppHandle, request_id: &str, mut event: Value) {
    event["requestId"] = json!(request_id);
    let _ = app.emit("agent-event", event);
}

async fn write_command(stdin: &Arc<Mutex<ChildStdin>>, command: Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(&command).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    let mut pipe = stdin.lock().await;
    pipe.write_all(&bytes).await.map_err(|e| e.to_string())?;
    pipe.flush().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agent_get_diagnostics(app: AppHandle, request_id: String) -> Result<Value, String> {
    if !valid_id(&request_id) {
        return Err("无效的任务标识".into());
    }
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("agent/diagnostics")
        .join(format!("{request_id}.json"));
    if !path.exists() {
        return Ok(json!({"text":"诊断仍在收集，或本轮没有诊断记录。","truncated":false}));
    }
    super::storage::read(&path)
}

#[tauri::command]
pub async fn agent_list_tasks(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
) -> Result<Vec<journal::TaskRecord>, String> {
    let slot = runtime.0.lock().await;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("agent");
    TaskJournal::new(&directory).recover(
        slot.as_ref().map(|task| task.request_id.as_str()),
        super::unix_timestamp(),
    )
}

#[tauri::command]
pub async fn agent_start(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    input: AgentStartInput,
) -> Result<(), String> {
    if !valid_id(&input.request_id) || !valid_id(&input.conversation_id) {
        return Err("无效的任务标识".into());
    }
    if input.prompt.len() > 100_000 {
        return Err("任务描述最多 100 KB".into());
    }
    let selected_workspace = input
        .cwd
        .as_deref()
        .filter(|path| !path.is_empty())
        .map(|path| std::fs::canonicalize(path).map_err(|_| "工作目录不存在或无法访问".to_string()))
        .transpose()?;
    if selected_workspace
        .as_ref()
        .is_some_and(|path| !path.is_dir())
    {
        return Err("请选择文件夹作为工作目录".into());
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("agent");
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let cwd = if input.unified {
        let path = data_dir.join("workspace");
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        std::fs::canonicalize(path).map_err(|e| e.to_string())?
    } else {
        selected_workspace.clone().ok_or("请选择工作目录")?
    };
    let attachments = app.state::<super::TextAttachmentStore>();
    let attachment = attachments.0.lock().map_err(|_| "无法读取附件")?.clone();
    let text = if input.prompt.trim().is_empty() && input.include_screenshot.unwrap_or(false) {
        "请描述截图中的内容"
    } else {
        &input.prompt
    };
    let (model_prompt, history_prompt) = super::chat::build_attachment_prompt(
        text,
        input.attachment_action.as_deref(),
        attachment.as_ref(),
    )?;
    if model_prompt.trim().is_empty() {
        return Err("请输入消息".into());
    }
    let images = if input.include_screenshot.unwrap_or(false) {
        let captures = app.state::<super::ScreenCaptureStore>();
        let capture = captures
            .0
            .lock()
            .map_err(|_| "无法读取截图")?
            .clone()
            .ok_or("请先框选截图区域")?;
        let (prefix, data) = capture.data_url.split_once(',').ok_or("截图格式无效")?;
        let mime = prefix
            .strip_prefix("data:")
            .and_then(|s| s.strip_suffix(";base64"))
            .ok_or("截图格式无效")?;
        vec![json!({"type":"image", "mimeType":mime, "data":data})]
    } else {
        Vec::new()
    };
    let mut slot = runtime.0.lock().await;
    if slot.is_some() {
        return Err("已有 Agent 任务正在执行，请先停止".into());
    }
    let journal = TaskJournal::new(&data_dir);
    let records = journal.recover(None, super::unix_timestamp())?;
    let verification = input
        .verification_of
        .as_deref()
        .map(|id| {
            records
                .iter()
                .find(|record| record.request_id == id)
                .filter(|record| {
                    matches!(
                        record.status.as_str(),
                        "interrupted" | "failed" | "cancelled" | "completed"
                    )
                })
                .cloned()
                .ok_or_else(|| "该任务不存在或尚未结束，请刷新任务记录".to_string())
        })
        .transpose()?;
    if input.resume_of.is_some() && input.verification_of.is_some() {
        return Err("核对与续跑不能同时启动".into());
    }
    let resumed = input
        .resume_of
        .as_deref()
        .map(|id| {
            records
                .iter()
                .find(|record| {
                    record.request_id == id
                        && matches!(
                            record.status.as_str(),
                            "failed" | "interrupted" | "cancelled"
                        )
                })
                .cloned()
                .ok_or("该任务不存在或无需续跑".to_string())
        })
        .transpose()?;
    let mut resume_root = resumed.as_ref().map(|record| record.request_id.clone());
    for _ in 0..records.len() {
        let parent = resume_root
            .as_ref()
            .and_then(|id| records.iter().find(|record| &record.request_id == id))
            .and_then(|record| record.resume_of.clone());
        if let Some(parent) = parent {
            resume_root = Some(parent);
        } else {
            break;
        }
    }
    let conversation_id = resumed
        .as_ref()
        .map(|record| record.conversation_id.clone())
        .unwrap_or_else(|| input.conversation_id.clone());
    let resuming = resumed.is_some();
    let read_only = verification.is_some();
    let settings = super::read_settings(&app);
    if settings.ai.model.trim().is_empty() || settings.ai.base_url.trim().is_empty() {
        return Err("请先在模型设置中配置模型和 API 地址".into());
    }
    let (node, resources) = runtime_paths(&app)?;
    if !node.is_file() || !resources.join("sidecar.mjs").is_file() {
        return Err("Agent 运行时未准备好，请运行 npm run agent:prepare 后重启 Piko".into());
    }
    let mut child = Command::new(node)
        .arg(resources.join("sidecar.mjs"))
        .current_dir(&cwd)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("无法启动 Pi Agent：{e}"))?;
    let stdin = Arc::new(Mutex::new(
        child.stdin.take().ok_or("无法创建 Agent 输入管道")?,
    ));
    let stdout = child.stdout.take().ok_or("无法创建 Agent 输出管道")?;
    let stderr = child.stderr.take().ok_or("无法创建 Agent 诊断管道")?;
    let diagnostics_dir = data_dir.join("diagnostics");
    let diagnostic_id = input.request_id.clone();
    let diagnostic_key = super::read_api_key().unwrap_or_default();
    tauri::async_runtime::spawn(async move {
        diagnostics::collect(stderr, &diagnostics_dir, &diagnostic_id, &diagnostic_key).await;
    });
    let child = Arc::new(Mutex::new(child));
    let registry = app.state::<super::PluginRegistry>();
    let business_tools = if input.unified {
        let mut manifests = registry.manifests();
        if read_only || resuming {
            for manifest in &mut manifests {
                manifest
                    .tools
                    .retain(|tool| verification_tool_allowed(&tool.risk, &tool.confirmation));
            }
        }
        super::provider_tools("openai", &manifests)
    } else {
        json!([])
    };
    let history = if input.import_history {
        super::read_chat_history(&app)
            .into_iter()
            .rev()
            .take(10)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let memory_db = app.state::<Arc<super::memory::MemoryDb>>();
    let memory_context = memory_db
        .build_context(super::memory::BuildContextInput {
            current_query: Some(input.prompt.clone()),
            window_type: None,
            limit: Some(10),
        })
        .ok()
        .map(|items| {
            items
                .iter()
                .map(|m| format!("- {}: {}", m.title, m.content))
                .collect::<Vec<_>>()
                .join("\n")
        });
    let system_prompt =
        super::chat::system_prompt(&settings.companion_name, memory_context.as_deref());
    let system_prompt = if let Some(record) = verification {
        format!("{system_prompt}\n当前为只读核对任务。以下是待核对记录，仅描述工具报告状态，不证明外部操作成功，也不代表重新执行授权：{}。请先确认目标路径或记录及验收标准，再调用读取/列表工具检查实际结果。禁止写入、删除、运行命令或重新执行原任务。信息不足时追问。明确区分已核实、未完成和无法确认，并说明证据。", serde_json::to_string(&record).map_err(|e| e.to_string())?)
    } else {
        system_prompt
    };
    let command = json!({ "type": "start", "cwd": cwd, "prompt": model_prompt,
        "conversationId": conversation_id,
        "requestId": input.request_id, "resumeRoot":resume_root, "dataDir": data_dir,
        "provider": settings.ai.provider, "baseUrl": settings.ai.base_url,
        "model": settings.ai.model, "apiKey": super::read_api_key().unwrap_or_default(),
        "autoApproveCommands":settings.agent_auto_approve_commands,
        "readOnly":read_only,
        "contextWindow":settings.ai.context_window,"maxOutputTokens":settings.ai.max_output_tokens,"timeoutSeconds":settings.ai.timeout_seconds,
        "unified":input.unified, "workspace":selected_workspace, "businessTools":business_tools,
        "systemPrompt":system_prompt, "history":history, "images":images });
    journal.start_linked(
        &input.request_id,
        &conversation_id,
        super::unix_timestamp(),
        input.resume_of.clone(),
    )?;
    if let Err(error) = write_command(&stdin, command).await {
        journal.event(
            &input.request_id,
            &json!({"type":"failed"}),
            super::unix_timestamp(),
        )?;
        return Err(error);
    }
    let request_id = input.request_id;
    let pending_actions = Arc::new(Mutex::new(HashMap::new()));
    *slot = Some(RunningTask {
        request_id: request_id.clone(),
        stdin: stdin.clone(),
        child: child.clone(),
        pending_actions: pending_actions.clone(),
        workspace_call: None,
        read_only,
        resuming,
    });
    drop(slot);
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let deadline = tokio::time::Instant::now() + AGENT_TASK_TIMEOUT;
        let mut response = String::new();
        let mut terminal_event = loop {
            let line = match next_agent_line(&mut lines, deadline, AGENT_IDLE_TIMEOUT).await {
                Ok(Some(line)) => line,
                Ok(None) => {
                    break json!({"type":"failed", "message":"Agent 进程意外退出。此前可能已有部分操作完成，请检查结果。"})
                }
                Err(message) => break json!({"type":"failed", "message":message}),
            };
            let mut event: Value = match serde_json::from_str(&line) {
                Ok(event) => event,
                Err(_) => {
                    break json!({"type":"failed", "message":"Agent 返回了无效的通信数据。此前可能已有部分操作完成，请检查结果。"})
                }
            };
            let kind = event["type"].as_str().unwrap_or("").to_string();
            if kind == "delta" {
                response.push_str(event["text"].as_str().unwrap_or(""));
            }
            if !matches!(kind.as_str(), "completed" | "failed" | "cancelled")
                && journal
                    .event(&request_id, &event, super::unix_timestamp())
                    .is_err()
            {
                break json!({"type":"failed", "message":"任务进度保存失败，已停止。此前可能已有部分操作完成，请先核对结果。"});
            }
            if kind == "app-tool" {
                handle_app_tool(&app, &request_id, &stdin, &pending_actions, &event).await;
                continue;
            }
            if kind == "completed" {
                let entry = super::ChatHistoryEntry {
                    id: request_id.clone(),
                    prompt: history_prompt.clone(),
                    response: response.clone(),
                    created_at: super::unix_timestamp(),
                };
                let saved = super::append_chat_history(&app, entry.clone()).and_then(|_| {
                    let context = app.state::<super::ChatContext>();
                    let mut history = context
                        .0
                        .lock()
                        .map_err(|_| "无法更新对话上下文".to_string())?;
                    super::append_session_chat_history(&mut history, entry);
                    Ok(())
                });
                if saved.is_err() {
                    event = json!({"type":"failed", "message":"任务已执行，但保存聊天记录失败。请检查结果，不要重复执行。"});
                }
                let _ = app.emit_to("panel", "chat-history-updated", ());
            }
            if kind == "protocol-error" {
                break json!({"type":"failed", "message":"Agent 通信协议错误，任务已停止。此前可能已有部分操作完成，请检查结果。"});
            }
            if matches!(kind.as_str(), "completed" | "cancelled" | "failed") {
                break event;
            }
            emit(&app, &request_id, event);
        };
        let _ = child.lock().await.kill().await;
        remove_drafts(&app, &pending_actions).await;
        let state = app.state::<AgentRuntime>();
        let mut slot = state.0.lock().await;
        let owned = slot
            .as_ref()
            .is_some_and(|task| task.request_id == request_id);
        if owned {
            if journal
                .event(&request_id, &terminal_event, super::unix_timestamp())
                .is_err()
            {
                terminal_event = json!({"type":"failed", "message":"任务已结束，但执行状态保存失败。请核对实际结果，不要直接重复执行。"});
            }
            *slot = None;
        }
        drop(slot);
        // Every terminal path releases the runtime and invalidates drafts before the UI can retry.
        if owned {
            emit(&app, &request_id, terminal_event);
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn agent_steer(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request_id: String,
    text: String,
) -> Result<(), String> {
    if text.trim().is_empty() || text.len() > 16_000 {
        return Err("补充要求应为 1 到 16000 字节".into());
    }
    let mut slot = runtime.0.lock().await;
    let task = slot
        .as_mut()
        .filter(|task| task.request_id == request_id)
        .ok_or("任务已结束，请发送新消息")?;
    remove_drafts(&app, &task.pending_actions).await;
    task.workspace_call = None;
    write_command(&task.stdin, json!({"type":"steer", "text":text})).await
}

#[tauri::command]
pub async fn agent_approve(
    runtime: State<'_, AgentRuntime>,
    request_id: String,
    approval_id: String,
    allowed: bool,
) -> Result<(), String> {
    let slot = runtime.0.lock().await;
    let task = slot
        .as_ref()
        .filter(|task| task.request_id == request_id)
        .ok_or("任务已结束")?;
    write_command(
        &task.stdin,
        json!({"type": "approval", "approvalId": approval_id, "allowed": allowed}),
    )
    .await
}

#[tauri::command]
pub async fn agent_cancel(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request_id: String,
) -> Result<(), String> {
    let slot = runtime.0.lock().await;
    let task = slot
        .as_ref()
        .filter(|task| task.request_id == request_id)
        .ok_or("任务已结束")?;
    let _ = write_command(&task.stdin, json!({"type": "cancel"})).await;
    let child = task.child.clone();
    let pending_actions = task.pending_actions.clone();
    drop(slot);
    // Cooperative cancellation first; kill a stalled model request after five seconds.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        let state = app.state::<AgentRuntime>();
        let mut slot = state.0.lock().await;
        if slot
            .as_ref()
            .is_some_and(|task| task.request_id == request_id)
        {
            let _ = child.lock().await.kill().await;
            remove_drafts(&app, &pending_actions).await;
            let saved = app
                .path()
                .app_data_dir()
                .map_err(|e| e.to_string())
                .and_then(|directory| {
                    TaskJournal::new(&directory.join("agent")).event(
                        &request_id,
                        &json!({"type":"cancelled"}),
                        super::unix_timestamp(),
                    )
                });
            *slot = None;
            drop(slot);
            emit(
                &app,
                &request_id,
                if saved.is_ok() {
                    json!({"type":"cancelled"})
                } else {
                    json!({"type":"failed", "message":"任务已停止，但状态保存失败。请核对实际结果，不要直接重复执行。"})
                },
            );
        }
    });
    Ok(())
}

async fn remove_drafts(app: &AppHandle, pending: &Arc<Mutex<HashMap<String, String>>>) {
    let ids: Vec<_> = pending.lock().await.drain().map(|(id, _)| id).collect();
    if let Ok(mut drafts) = app.state::<super::ActionDrafts>().0.lock() {
        for id in ids {
            drafts.remove(&id);
        }
    }
}

async fn handle_app_tool(
    app: &AppHandle,
    request_id: &str,
    stdin: &Arc<Mutex<ChildStdin>>,
    pending: &Arc<Mutex<HashMap<String, String>>>,
    event: &Value,
) {
    let call_id = event["callId"].as_str().unwrap_or("").to_string();
    let name = event["name"].as_str().unwrap_or("");
    if name == "piko_select_workspace" {
        let runtime = app.state::<AgentRuntime>();
        let mut slot = runtime.0.lock().await;
        if let Some(task) = slot.as_mut().filter(|task| task.request_id == request_id) {
            task.workspace_call = Some(call_id);
            emit(app, request_id, json!({"type":"workspace-required"}));
        }
        return;
    }
    let read_only = {
        let runtime = app.state::<AgentRuntime>();
        let slot = runtime.0.lock().await;
        match slot.as_ref().filter(|task| task.request_id == request_id) {
            Some(task) => task.read_only || task.resuming,
            None => return,
        }
    };
    let result = (|| -> Result<Option<Value>, String> {
        let registry = app.state::<super::PluginRegistry>();
        let call = registry.decode_tool_call(name, event["arguments"].clone())?;
        let manifest = registry.tool_manifest(&call)?;
        if read_only && !verification_tool_allowed(&manifest.risk, &manifest.confirmation) {
            return Err(
                "当前仅核对结果，禁止修改数据；如需继续执行，请先结束核对并明确新指令".into(),
            );
        }
        if manifest.confirmation != "never"
            || matches!(manifest.risk.as_str(), "write" | "sensitive")
        {
            let draft = super::action_draft_from_tool_call(&call, chrono::Local::now())?;
            app.state::<super::ActionDrafts>()
                .0
                .lock()
                .map_err(|_| "无法保存待确认操作")?
                .insert(draft.id.clone(), draft.clone());
            Ok(Some(json!({"draft":draft})))
        } else {
            registry
                .execute(app, call)
                .map(|value| Some(json!({"result":value})))
        }
    })();
    match result {
        Ok(Some(value)) if value.get("draft").is_some() => {
            let id = value["draft"]["id"].as_str().unwrap().to_string();
            pending.lock().await.insert(id, call_id);
            emit(
                app,
                request_id,
                json!({"type":"action-proposed", "draft":value["draft"]}),
            );
        }
        Ok(value) => {
            let _ = write_command(stdin, json!({"type":"app-result", "callId":call_id, "result":value.and_then(|v| v.get("result").cloned())})).await;
        }
        Err(error) => {
            let _ = write_command(
                stdin,
                json!({"type":"app-result", "callId":call_id, "error":error}),
            )
            .await;
        }
    }
}

#[tauri::command]
pub async fn agent_select_workspace(
    runtime: State<'_, AgentRuntime>,
    request_id: String,
    path: Option<String>,
) -> Result<(), String> {
    let mut slot = runtime.0.lock().await;
    let task = slot
        .as_mut()
        .filter(|task| task.request_id == request_id)
        .ok_or("对话已结束")?;
    if task.workspace_call.is_none() {
        return Err("当前无需选择目录".into());
    }
    let result = path
        .map(|path| std::fs::canonicalize(path).map_err(|_| "目录不存在".to_string()))
        .transpose()?;
    if result.as_ref().is_some_and(|path| !path.is_dir()) {
        return Err("请选择文件夹".into());
    }
    let call_id = task.workspace_call.take().ok_or("当前无需选择目录")?;
    write_command(&task.stdin, json!({"type":"app-result", "callId":call_id,
        "result":result.as_ref().map(|path| json!({"path":path})),
        "error":if result.is_none() { Some("用户取消选择工作目录，不要操作本地文件") } else { None } })).await
}

#[tauri::command]
pub async fn agent_confirm_action(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request_id: String,
    id: String,
    selected_indexes: Option<Vec<usize>>,
) -> Result<(), String> {
    let (stdin, call_id) = {
        let slot = runtime.0.lock().await;
        let task = slot
            .as_ref()
            .filter(|task| task.request_id == request_id)
            .ok_or("对话已结束")?;
        let call_id = task
            .pending_actions
            .lock()
            .await
            .remove(&id)
            .ok_or("确认卡片已失效")?;
        (task.stdin.clone(), call_id)
    };
    let draft = app
        .state::<super::ActionDrafts>()
        .0
        .lock()
        .map_err(|_| "无法读取确认记录")?
        .get(&id)
        .cloned();
    match super::confirm_chat_action(app.clone(), app.state(), app.state(), id, selected_indexes) {
        Ok(execution) => {
            let verified = draft.as_ref().is_some_and(|draft| {
                let stored = match draft.plugin_id.as_str() {
                    "piko.memos" => serde_json::to_value(super::read_memos(&app)),
                    "piko.reminders" => serde_json::to_value(super::read_reminders(&app)),
                    "piko.calendar" => serde_json::to_value(super::read_calendar_events(&app)),
                    _ => return false,
                };
                stored.is_ok_and(|stored| {
                    verify_entities(&draft.tool_name, &execution.result, &stored)
                })
            });
            write_command(&stdin, json!({"type":"app-result", "callId":call_id, "result":{
            "message":execution.message, "result":execution.result, "verification":{"state":if verified { "verified" } else { "unknown" },"kind":"local-record"}, "instruction":"用户已确认且操作已经执行。请汇报结果，不要重复调用写入工具。"
        }})).await
        }
        Err(error) => {
            let _ = write_command(
                &stdin,
                json!({"type":"app-result", "callId":call_id, "error":error}),
            )
            .await;
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn agent_reject_action(
    app: AppHandle,
    runtime: State<'_, AgentRuntime>,
    request_id: String,
    id: String,
) -> Result<(), String> {
    let slot = runtime.0.lock().await;
    let task = slot
        .as_ref()
        .filter(|task| task.request_id == request_id)
        .ok_or("对话已结束")?;
    let call_id = task
        .pending_actions
        .lock()
        .await
        .remove(&id)
        .ok_or("确认卡片已失效")?;
    super::reject_chat_action(app.state(), id)?;
    write_command(
        &task.stdin,
        json!({"type":"app-result", "callId":call_id, "result":{
            "status":"cancelled", "executed":false, "draftShown":true,
            "message":"确认卡片已展示，用户点击了取消，操作未执行。请告知已取消，不要声称卡片生成失败，不要重试或绕过。"
        }}),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::{
        next_agent_line, valid_id, verification_tool_allowed, verify_entities, TIMEOUT_MESSAGE,
    };
    use std::time::Duration;
    use tokio::io::{AsyncWriteExt, BufReader};

    #[test]
    fn business_readback_validates_creation_and_deletion_from_actual_records() {
        let entity = serde_json::json!({"id":"event-1", "title":"评审"});
        assert!(verify_entities(
            "create_event",
            &entity,
            &serde_json::json!([entity])
        ));
        assert!(!verify_entities(
            "create_event",
            &entity,
            &serde_json::json!([])
        ));
        assert!(verify_entities(
            "delete_event",
            &entity,
            &serde_json::json!([])
        ));
        assert!(!verify_entities(
            "delete_event",
            &entity,
            &serde_json::json!([entity])
        ));
        assert!(!verify_entities(
            "create_event",
            &serde_json::json!({"title":"无标识"}),
            &serde_json::json!([])
        ));
    }

    #[test]
    fn verification_allows_only_unconfirmed_read_tools() {
        assert!(verification_tool_allowed("read", "never"));
        for (risk, confirmation) in [
            ("write", "never"),
            ("sensitive", "always"),
            ("read", "always"),
            ("unknown", "never"),
        ] {
            assert!(!verification_tool_allowed(risk, confirmation));
        }
    }

    #[test]
    fn stalled_agent_times_out_without_waiting_for_eof() {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(async {
                let (_writer, reader) = tokio::io::duplex(64);
                let mut lines = tokio::io::AsyncBufReadExt::lines(BufReader::new(reader));
                let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
                assert_eq!(
                    next_agent_line(&mut lines, deadline, Duration::from_millis(10))
                        .await
                        .unwrap_err(),
                    TIMEOUT_MESSAGE
                );
            });
    }

    #[test]
    fn task_deadline_applies_even_when_idle_limit_is_longer() {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(async {
                let (mut writer, reader) = tokio::io::duplex(64);
                writer.write_all(b"first\n").await.unwrap();
                let mut lines = tokio::io::AsyncBufReadExt::lines(BufReader::new(reader));
                let deadline = tokio::time::Instant::now() + Duration::from_millis(10);
                assert_eq!(
                    next_agent_line(&mut lines, deadline, Duration::from_secs(60))
                        .await
                        .unwrap()
                        .as_deref(),
                    Some("first")
                );
                assert_eq!(
                    next_agent_line(&mut lines, deadline, Duration::from_secs(60))
                        .await
                        .unwrap_err(),
                    TIMEOUT_MESSAGE
                );
            });
    }
    #[test]
    fn conversation_ids_cannot_escape_storage() {
        assert!(valid_id("550e8400-e29b-41d4-a716-446655440000"));
        for id in ["", "../other", "/tmp/session", "a/b", "a\\b"] {
            assert!(!valid_id(id));
        }
        assert!(!valid_id(&"a".repeat(81)));
    }
}
