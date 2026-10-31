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
    device_confirmation: bool,
) -> Result<String, String> {
    let DeviceTurn {
        device,
        session,
        turn,
        prompt,
    } = input;
    let (conversation, request) = identifiers(device, session, turn);
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
    crate::agent::start_passport_agent(app.clone(), request.clone(), conversation.clone(), prompt)
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
                if let Some(p) = pending.pop_front_if(|p| !p.card.desktop_only && p.card.nonce==decision.nonce && p.since.elapsed()<=Duration::from_secs(120)) {
                    let _=tx.send(Update::ConfirmationResolved(p.card.nonce.clone()));
                    let _=tx.send(Update::Stage("working"));
                    if let Err(message)=resolve(&app,&request,p.kind,decision.allowed).await {
                        let _=tx.send(Update::Notice(message)); open_desktop(&app,&conversation).await?;
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
                        let (message,desktop_only)=preview(draft,device_confirmation);
                        pending.push_back(Pending {card:Confirmation {nonce:nonce()?,message,desktop_only},kind:Kind::Action(id),since:Instant::now()});
                        if pending.len()>16 {return Err("待确认操作过多，请在电脑处理".into());}
                        if desktop_only {open_desktop(&app,&conversation).await?;}
                        notify_front(&pending,tx);
                    },
                    "approval"=>{
                        let id=event["approvalId"].as_str().ok_or("授权缺少标识")?.to_owned();
                        if pending.iter().any(|p|matches!(&p.kind,Kind::Approval(old) if old==&id)) {continue;}
                        pending.push_back(Pending {card:Confirmation {nonce:nonce()?,message:"文件或命令操作需要在电脑查看完整内容并授权。".into(),desktop_only:true},kind:Kind::Approval(id),since:Instant::now()});
                        notify_front(&pending,tx); if let Err(e)=open_desktop(&app,&conversation).await{let _=tx.send(Update::Notice(e));}
                    },
                    "workspace-required"=>{
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
