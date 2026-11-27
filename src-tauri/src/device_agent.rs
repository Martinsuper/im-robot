//! Passport uses the same Agent executor; device decisions only resolve a currently reviewed business draft.
use crate::device_voice::Update;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::Sender,
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Listener, Manager};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(crate) struct Confirmation {
    pub nonce: String,
    pub message: String,
    pub desktop_only: bool,
}
pub(crate) struct Decision {
    pub nonce: String,
    pub allowed: bool,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConfirmationMode {
    Desktop,
    Device,
    Voice,
}
impl From<bool> for ConfirmationMode {
    fn from(enabled: bool) -> Self {
        if enabled {
            Self::Device
        } else {
            Self::Desktop
        }
    }
}

/// Voice must review the complete operation, without Passport font limits or truncation.
fn voice_preview(heading: &str, arguments: &Value) -> (String, bool) {
    let details = serde_json::to_string_pretty(arguments).unwrap_or_default();
    reviewable_voice_message(format!("{heading}\n参数：{details}"))
}
fn reviewable_voice_message(message: String) -> (String, bool) {
    if message.chars().count() > 360
        || message.chars().any(|c| c.is_control() && c != '\n')
        || crate::speech::text_for_speech(&message) != message
    {
        (
            "操作内容过长或包含无法完整朗读的字符，本次不通过语音执行。".into(),
            true,
        )
    } else {
        (message, false)
    }
}

fn action_preview(draft: &Value, mode: ConfirmationMode) -> (String, bool) {
    if mode != ConfirmationMode::Voice {
        return preview(draft, mode == ConfirmationMode::Device);
    }
    let summary = draft["summary"].as_str().unwrap_or("待确认操作");
    let heading = if matches!(
        draft["pluginId"].as_str(),
        Some("piko.calendar" | "piko.reminders" | "piko.memos" | "piko.focus")
    ) {
        summary.to_string()
    } else {
        format!(
            "{summary}。操作：{}，{}",
            draft["pluginId"].as_str().unwrap_or("未知应用"),
            draft["toolName"].as_str().unwrap_or("未知操作")
        )
    };
    if draft["pluginId"] == "piko.calendar" && draft["toolName"] == "create_event" {
        if let Some(calendar) = voice_calendar_preview(&draft["arguments"]) {
            // Calendar preview preserves extra fields as well as exact time/offset.
            return reviewable_voice_message(calendar);
        }
    }
    voice_preview(&heading, &draft["arguments"])
}

fn voice_calendar_preview(args: &Value) -> Option<String> {
    use chrono::Timelike;
    let title = args["title"].as_str()?;
    let start = chrono::DateTime::parse_from_rfc3339(args["startAt"].as_str()?).ok()?;
    let end = chrono::DateTime::parse_from_rfc3339(args["endAt"].as_str()?).ok()?;
    let time = |date: chrono::DateTime<chrono::FixedOffset>| {
        let mut text = date.format("%Y年%-m月%-d日%-H点%M分").to_string();
        if date.second() != 0 || date.nanosecond() != 0 {
            text.push_str(&date.format("%S%.f秒").to_string());
        }
        if date.offset().local_minus_utc() == 8 * 3600 {
            text.push_str("，北京时间");
        } else {
            text.push_str(&format!("，UTC时区{}", date.offset()));
        }
        text
    };
    let mut text = format!(
        "创建日程。标题：{title}。开始：{}。结束：{}。",
        time(start),
        time(end)
    );
    let mut remaining = args.as_object()?.clone();
    for key in ["title", "startAt", "endAt"] {
        remaining.remove(key);
    }
    if !remaining.is_empty() {
        text.push_str(&format!(
            "其他参数：{}",
            serde_json::to_string(&remaining).ok()?
        ));
    }
    Some(text)
}
#[derive(Clone)]
enum Kind {
    Action(String),
    Approval(String),
    Workspace,
}
struct Pending {
    card: Confirmation,
    kind: Kind,
    since: Instant,
}
fn take_decision(pending: &mut VecDeque<Pending>, decision: &Decision) -> Option<Pending> {
    pending.pop_front_if(|p| {
        (!p.card.desktop_only || !decision.allowed)
            && p.card.nonce == decision.nonce
            && p.since.elapsed() <= Duration::from_secs(120)
    })
}
fn identifiers(device: &str, session: Option<&str>, turn: &str) -> (String, String) {
    let context = session
        .map(|session| format!("{device}:{session}"))
        .unwrap_or_else(|| device.to_owned());
    let device_hash = format!("{:x}", Sha256::digest(context.as_bytes()));
    let turn_hash = format!("{:x}", Sha256::digest(format!("{device}:{turn}")));
    (
        format!("passport-{}", &device_hash[..24]),
        format!("passport-{}", &turn_hash[..32]),
    )
}
fn nonce() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "无法生成操作确认码".to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn calendar_preview(args: &Value) -> Option<String> {
    let title = args["title"].as_str()?;
    let start = chrono::DateTime::parse_from_rfc3339(args["startAt"].as_str()?).ok()?;
    let end = chrono::DateTime::parse_from_rfc3339(args["endAt"].as_str()?).ok()?;
    let mut text = format!(
        "创建日程\n标题：{title}\n开始：{}\n结束：{}",
        start.format("%Y-%m-%d %H:%M:%S%.f %:z"),
        end.format("%Y-%m-%d %H:%M:%S%.f %:z")
    );
    let mut remaining = args.as_object()?.clone();
    for key in ["title", "startAt", "endAt"] {
        remaining.remove(key);
    }
    if !remaining.is_empty() {
        text.push_str(&format!(
            "\n其他参数：{}",
            serde_json::to_string_pretty(&remaining).ok()?
        ));
    }
    Some(text)
}

fn preview(draft: &Value, device_confirmation: bool) -> (String, bool) {
    let plugin = draft["pluginId"].as_str().unwrap_or("");
    let allowed = matches!(
        plugin,
        "piko.reminders" | "piko.calendar" | "piko.memos" | "piko.focus"
    );
    let summary = draft["summary"].as_str().unwrap_or("待确认操作");
    let args = serde_json::to_string_pretty(&draft["arguments"]).unwrap_or_default();
    let complete = if plugin == "piko.calendar" && draft["toolName"] == "create_event" {
        calendar_preview(&draft["arguments"]).unwrap_or_else(|| format!("{summary}\n\n{args}"))
    } else {
        format!("{summary}\n\n{args}")
    };
    let renderable = complete.chars().all(|c| {
        (c.is_ascii() && (!c.is_control() || c == '\n'))
            || include_str!("../resources/passport/font-characters.txt").contains(c)
    });
    if device_confirmation
        && allowed
        && renderable
        && complete.chars().count() <= 600
        && complete.len() <= 2200
    {
        (complete, false)
    } else {
        (
            format!(
                "{}\n\n请到电脑核对完整内容并确认。",
                summary
                    .chars()
                    .take(180)
                    .map(|c| {
                        if (c.is_ascii() && (!c.is_control() || c == '\n'))
                            || include_str!("../resources/passport/font-characters.txt").contains(c)
                        {
                            c
                        } else {
                            '□'
                        }
                    })
                    .collect::<String>()
            ),
            true,
        )
    }
}
struct ListenerGuard {
    app: AppHandle,
    id: tauri::EventId,
}
impl Drop for ListenerGuard {
    fn drop(&mut self) {
        self.app.unlisten(self.id);
    }
}
struct TaskGuard {
    app: AppHandle,
    request: String,
    finished: bool,
}
impl Drop for TaskGuard {
    fn drop(&mut self) {
        if !self.finished {
            let app = self.app.clone();
            let id = self.request.clone();
            tauri::async_runtime::spawn(async move {
                let _ = crate::agent::agent_cancel(app.clone(), app.state(), id).await;
            });
        }
    }
}
async fn open_desktop(app: &AppHandle, conversation: &str) -> Result<(), String> {
    crate::conversation_windows::conversation_open_window(
        app.clone(),
        conversation.into(),
        "Passport 语音任务".into(),
    )
    .await
    .map(|_| ())
    .map_err(|_| "无法打开任务确认窗口，请在电脑重新打开 Piko".into())
}
fn notify_front(queue: &VecDeque<Pending>, tx: &Sender<Update>) {
    if let Some(p) = queue.front() {
        let _ = tx.send(Update::Confirmation(p.card.clone()));
    } else {
        let _ = tx.send(Update::Stage("working"));
    }
}
async fn resolve(app: &AppHandle, request: &str, kind: Kind, allowed: bool) -> Result<(), String> {
    let runtime = app.state::<crate::agent::AgentRuntime>();
    match kind {
        Kind::Action(id) if allowed => {
            crate::agent::agent_confirm_action(app.clone(), runtime, request.into(), id, None).await
        }
        Kind::Action(id) => {
            crate::agent::agent_reject_action(app.clone(), runtime, request.into(), id).await
        }
        Kind::Approval(id) => {
            crate::agent::agent_approve(app.clone(), runtime, request.into(), id, allowed).await
        }
        Kind::Workspace => return Err("工作目录需要在电脑端选择".into()),
    }
    .map_err(|_| "确认已失效或操作未完成，请在电脑查看任务结果".into())
}
fn resolved(kind: &Kind, event: &Value) -> bool {
    match kind {
        Kind::Action(id) => event["type"] == "action-resolved" && event["id"].as_str() == Some(id),
        Kind::Approval(id) => {
            matches!(
                event["type"].as_str(),
                Some("approval-resolved" | "approval-expired")
            ) && event["approvalId"].as_str() == Some(id)
        }
        Kind::Workspace => event["type"] == "workspace-resolved",
    }
}
/// A device turn's identity and prompt, kept together across the agent bridge.
pub(crate) struct DeviceTurn<'a> {
    pub device: &'a str,
    pub session: Option<&'a str>,
    pub turn: &'a str,
    pub prompt: String,
}

pub(crate) async fn run(
    app: AppHandle,
    input: DeviceTurn<'_>,
    tx: &Sender<Update>,
    cancel: &CancellationToken,
    mut decisions: mpsc::Receiver<Decision>,
    confirmation_mode: ConfirmationMode,
) -> Result<String, String> {
    let DeviceTurn {
        device,
        session,
        turn,
        prompt,
    } = input;
    let (conversation, request) = identifiers(device, session, turn);
    let mut workspace = crate::conversation_views::conversation_get_view(
        app.clone(),
        app.state(),
        conversation.clone(),
    )
    .ok()
    .map(|view| view.cwd)
    .filter(|cwd| !cwd.trim().is_empty());
    let (events_tx, mut events) = mpsc::channel::<Value>(128);
    let overflow = Arc::new(AtomicBool::new(false));
    let overflow_event = overflow.clone();
    let expected = request.clone();
    let listener = app.listen("agent-event", move |event| {
        if let Ok(value) = serde_json::from_str::<Value>(event.payload()) {
            if value["requestId"].as_str() == Some(&expected) && events_tx.try_send(value).is_err()
            {
                overflow_event.store(true, Ordering::Relaxed);
            }
        }
    });
    let _listener = ListenerGuard {
        app: app.clone(),
        id: listener,
    };
    let mut guard = TaskGuard {
        app: app.clone(),
        request: request.clone(),
        finished: false,
    };
    crate::agent::start_passport_agent(
        app.clone(),
        request.clone(),
        conversation.clone(),
        prompt,
        confirmation_mode == ConfirmationMode::Voice,
    )
    .await
    .map_err(|_| "任务代理未能启动，请在电脑检查模型配置和 Agent 运行时".to_string())?;
    let mut pending = VecDeque::<Pending>::new();
    let mut response = String::new();
    let mut timer = tokio::time::interval(Duration::from_millis(250));
    loop {
        tokio::select! {
            biased;
            _=cancel.cancelled()=>return Err("已取消语音任务；请检查是否已有操作完成".into()),
            _=timer.tick()=>{
                if overflow.load(Ordering::Relaxed) {return Err("任务事件过多，已停止，请在电脑查看结果".into());}
                if pending.front().is_some_and(|p|p.since.elapsed()>Duration::from_secs(120)) {
                    if let Some(p)=pending.pop_front() {
                        let _=tx.send(Update::ConfirmationResolved(p.card.nonce.clone()));
                        if matches!(p.kind,Kind::Workspace) {return Err("工作目录选择已超时，任务已停止".into());}
                        let message=if resolve(&app,&request,p.kind,false).await.is_ok() {"确认已过期，此次待确认操作未执行。"} else {"确认状态已变化，请在电脑查看实际执行结果。"};
                        let _=tx.send(Update::Notice(message.into()));
                        notify_front(&pending,tx);
                    }
                }
            },
            decision=decisions.recv()=>{
                let Some(decision)=decision else {return Err("设备确认通道已关闭".into());};
                if let Some(p) = take_decision(&mut pending, &decision) {
                    let _=tx.send(Update::ConfirmationResolved(p.card.nonce.clone()));
                    let _=tx.send(Update::Stage("working"));
                    if let Err(message)=resolve(&app,&request,p.kind,decision.allowed).await {
                        let _=tx.send(Update::Notice(message));
                        if confirmation_mode != ConfirmationMode::Voice { open_desktop(&app,&conversation).await?; }
                    }
                    notify_front(&pending,tx);
                }
            },
            event=events.recv()=>{
                let event=event.ok_or("任务连接已中断，请到电脑查看结果")?;
                match event["type"].as_str().unwrap_or("") {
                    "delta"=>{
                        let text=event["text"].as_str().unwrap_or("");
                        if response.len()+text.len()>100_000 {return Err("任务回复过长，请在电脑查看结果".into());}
                        response.push_str(text);
                    },
                    "tool-start"=>{if pending.is_empty() {let _=tx.send(Update::Stage("working"));}},
                    "action-proposed"=>{
                        let draft=&event["draft"]; let id=draft["id"].as_str().ok_or("操作确认缺少标识")?.to_owned();
                        if pending.iter().any(|p|matches!(&p.kind,Kind::Action(old) if old==&id)) {continue;}
                        let (message,desktop_only)=action_preview(draft,confirmation_mode);
                        pending.push_back(Pending {card:Confirmation {nonce:nonce()?,message,desktop_only},kind:Kind::Action(id),since:Instant::now()});
                        if pending.len()>16 {return Err("待确认操作过多，请在电脑处理".into());}
                        if desktop_only && confirmation_mode != ConfirmationMode::Voice {open_desktop(&app,&conversation).await?;}
                        notify_front(&pending,tx);
                    },
                    "approval"=>{
                        let id=event["approvalId"].as_str().ok_or("授权缺少标识")?.to_owned();
                        if pending.iter().any(|p|matches!(&p.kind,Kind::Approval(old) if old==&id)) {continue;}
                        let (message,desktop_only) = if confirmation_mode == ConfirmationMode::Voice {
                            if let Some(cwd) = workspace.as_deref() {
                                let tool = match event["tool"].as_str().unwrap_or("未知工具") {
                                    "bash" | "powershell" => "运行命令",
                                    "write" => "写入文件",
                                    "edit" => "修改文件",
                                    tool => tool,
                                };
                                voice_preview(&format!("需要授权：{tool}。工作目录：{cwd}"), &event["arguments"])
                            } else { ("无法确认文件操作的工作目录，本次不通过语音执行。".into(),true) }
                        } else { ("文件或命令操作需要在电脑查看完整内容并授权。".into(),true) };
                        pending.push_back(Pending {card:Confirmation {nonce:nonce()?,message,desktop_only},kind:Kind::Approval(id),since:Instant::now()});
                        notify_front(&pending,tx);
                        if confirmation_mode != ConfirmationMode::Voice {
                            if let Err(e)=open_desktop(&app,&conversation).await{let _=tx.send(Update::Notice(e));}
                        }
                    },
                    "workspace-required"=>{
                        if confirmation_mode == ConfirmationMode::Voice {
                            return Err("这项操作需要选择本地目录，当前语音任务已停止，未批准文件操作。".into());
                        }
                        if !pending.iter().any(|p|matches!(p.kind,Kind::Workspace)) {
                            pending.push_back(Pending {card:Confirmation {nonce:nonce()?,message:"请在电脑的 Passport 语音任务窗口中选择工作目录。".into(),desktop_only:true},kind:Kind::Workspace,since:Instant::now()});
                            notify_front(&pending,tx); if let Err(e)=open_desktop(&app,&conversation).await{let _=tx.send(Update::Notice(e));}
                        }
                    },
                    "steering-accepted"=>{
                        for p in pending.drain(..){let _=tx.send(Update::ConfirmationResolved(p.card.nonce));}
                    let _=tx.send(Update::Notice("电脑端已更新任务要求，旧确认已失效。".into())); notify_front(&pending,tx);
                    },
                    "action-resolved"|"approval-resolved"|"approval-expired"|"workspace-resolved"=>{
                        if event["type"] == "workspace-resolved" {
                            workspace = event["cwd"].as_str().map(str::to_owned);
                        }
                        pending.retain(|p|{
                        if resolved(&p.kind,&event){let _=tx.send(Update::ConfirmationResolved(p.card.nonce.clone()));false}else{true}
                    }); notify_front(&pending,tx);
                    },
                    "completed"=>{
                        guard.finished=true;
                        let text=event["response"].as_str().filter(|s|!s.trim().is_empty()).unwrap_or(&response).trim();
                        return Ok(if text.is_empty() {"任务已结束，请在电脑查看执行记录。".into()} else {text.to_owned()});
                    },
                    "failed"=>{guard.finished=true;return Err("任务未完成；此前可能已有部分操作执行，请在电脑查看任务记录".into());},
                    "protocol-error"=>return Err("任务协议异常，已停止，请在电脑检查执行记录".into()),
                    "cancelled"=>{guard.finished=true;return Err("任务已取消；请检查是否已有操作完成".into());},
                    _=>(),
                }
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn voice_review_preserves_full_calendar_details_without_passport_font_limits() {
        let draft = json!({"pluginId":"piko.calendar","toolName":"create_event","summary":"创建日程", "arguments":{"title":"𠮷野家聚餐","startAt":"2026-11-09T09:00:30.125+08:00","endAt":"2026-11-09T10:00:00+08:00","location":"会议室","notes":"请带材料"}});
        let (message, desktop) = action_preview(&draft, ConfirmationMode::Voice);
        assert!(!desktop);
        for expected in [
            "𠮷野家聚餐",
            "2026年11月9日9点00分30.125秒",
            "北京时间",
            "会议室",
            "请带材料",
        ] {
            assert!(message.contains(expected), "missing {expected}: {message}");
        }
        assert!(action_preview(&draft, ConfirmationMode::Device).1);
        assert!(action_preview(&draft, ConfirmationMode::Desktop).1);
        let mut long = draft.clone();
        long["arguments"]["notes"] = json!("长".repeat(400));
        assert!(action_preview(&long, ConfirmationMode::Voice).1);
        assert!(reviewable_voice_message("标题含有\0控制字符".into()).1);
        assert!(reviewable_voice_message("标题含有🍎表情".into()).1);
    }
    #[test]
    fn only_current_unexpired_nonce_can_be_approved_and_cannot_be_replayed() {
        let pending = |nonce: &str, desktop_only: bool, age: u64| Pending {
            card: Confirmation {
                nonce: nonce.into(),
                message: "待确认".into(),
                desktop_only,
            },
            kind: Kind::Action(nonce.into()),
            since: Instant::now() - Duration::from_secs(age),
        };
        let approve = |nonce: &str| Decision {
            nonce: nonce.into(),
            allowed: true,
        };
        let mut queue = VecDeque::from([pending("first", false, 0), pending("second", false, 0)]);
        assert!(take_decision(&mut queue, &approve("second")).is_none());
        assert!(take_decision(&mut queue, &approve("first")).is_some());
        assert!(take_decision(&mut queue, &approve("first")).is_none());
        assert!(take_decision(&mut queue, &approve("second")).is_some());
        queue.push_back(pending("expired", false, 121));
        assert!(take_decision(&mut queue, &approve("expired")).is_none());
        queue.clear();
        queue.push_back(pending("unreviewable", true, 0));
        assert!(take_decision(&mut queue, &approve("unreviewable")).is_none());
        assert!(take_decision(
            &mut queue,
            &Decision {
                nonce: "unreviewable".into(),
                allowed: false
            }
        )
        .is_some());
    }
    #[test]
    fn complete_business_previews_are_device_reviewable_but_large_or_system_actions_are_not() {
        let small = json!({"pluginId":"piko.reminders","summary":"明天提醒买牛奶","arguments":{"title":"买牛奶","dueAt":"2026-10-25T09:00:00+08:00"}});
        let (text, desktop) = preview(&small, true);
        assert!(!desktop);
        assert!(preview(&small, false).1);
        assert!(text.contains("2026-10-25T09:00:00+08:00"));
        let mut large = small.clone();
        large["arguments"] = json!({"content":"长".repeat(700)});
        assert!(preview(&large, true).1);
        let system = json!({"pluginId":"external.files","summary":"写入文件","arguments":{}});
        assert!(preview(&system, true).1);
        let mut missing = small.clone();
        missing["arguments"] = json!({"title":"𠮷"});
        assert!(preview(&missing, true).1);
    }
    #[test]
    fn stable_conversations_and_unique_turns_use_safe_agent_ids() {
        let (c, r) = identifiers("passport-test_1", Some("session-a"), "boot-voice-1");
        let (c2, r2) = identifiers("passport-test_1", Some("session-a"), "boot-voice-2");
        assert_eq!(c, c2);
        assert_ne!(
            c,
            identifiers("passport-test_1", Some("session-b"), "boot-voice-3").0
        );
        assert_eq!(
            identifiers("passport-test_1", None, "old-1").0,
            identifiers("passport-test_1", None, "old-2").0
        );
        assert_ne!(r, r2);
        assert!(c.len() <= 80 && r.len() <= 80);
        assert!(c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
    }
    #[test]
    fn calendar_cards_show_full_fields_and_preserve_extra_arguments() {
        let draft = json!({"pluginId":"piko.calendar","toolName":"create_event","summary":"创建日程", "arguments":{"title":"评审","startAt":"2026-10-25T09:00:00+08:00","endAt":"2026-10-25T10:00:00+08:00","location":"会议室"}});
        let (card, desktop) = preview(&draft, true);
        assert!(!desktop);
        for field in [
            "标题：评审",
            "开始：2026-10-25 09:00:00 +08:00",
            "结束：2026-10-25 10:00:00 +08:00",
            "会议室",
        ] {
            assert!(card.contains(field));
        }
        assert!(preview(&draft, false).1);
        let mut precise = draft.clone();
        precise["arguments"]["startAt"] = json!("2026-10-25T09:00:30.125+08:00");
        assert!(preview(&precise, true).0.contains("09:00:30.125 +08:00"));
        precise["arguments"]["title"] = json!("hidden\u{0}suffix");
        assert!(preview(&precise, true).1);
    }

    #[test]
    fn resolution_must_match_the_exact_control() {
        let action = Kind::Action("action-1".into());
        assert!(!resolved(
            &action,
            &json!({"type":"action-resolved","id":"other"})
        ));
        assert!(resolved(
            &action,
            &json!({"type":"action-resolved","id":"action-1"})
        ));
        assert!(!resolved(
            &Kind::Approval("a".into()),
            &json!({"type":"approval-resolved","approvalId":"b"})
        ));
    }
}
