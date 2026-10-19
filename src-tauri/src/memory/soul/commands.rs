use super::{activity, diagnostics, model::*, open_loops, profile, settings, store};
use crate::memory::MemoryDb;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
pub fn soul_get_settings(
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
) -> Result<SoulSettings, String> {
    if !boot_ok(&app) {
        return Err("storage_unavailable".into());
    }
    let mut conn = db.0.lock().map_err(|_| "storage_unavailable")?;
    settings::get(&mut conn, now())
}

#[tauri::command]
pub fn soul_update_settings(
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
    input: UpdateSoulSettingsInput,
) -> Result<SoulSettings, String> {
    if !boot_ok(&app) {
        return Err("storage_unavailable".into());
    }
    let mut conn = db.0.lock().map_err(|_| "storage_unavailable")?;
    settings::update(&mut conn, &input, now())?;
    let updated = settings::get(&mut conn, now())?;
    drop(conn);
    reconcile_visible(&app);
    let _ = app.emit("soul:changed", ());
    Ok(updated)
}

#[tauri::command]
pub fn soul_clear(
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
    input: ClearSoulInput,
) -> Result<(), String> {
    if !boot_ok(&app) {
        return Err("storage_unavailable".into());
    }
    let mut conn = db.0.lock().map_err(|_| "storage_unavailable")?;
    settings::clear(&mut conn, &input.scopes, now())?;
    drop(conn);
    reconcile_visible(&app);
    let _ = app.emit("soul:changed", ());
    let _ = app.emit("memories-updated", ());
    Ok(())
}

fn boot_ok(app: &AppHandle) -> bool {
    app.try_state::<SoulBootStatus>()
        .is_some_and(|status| status.0)
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

#[tauri::command]
pub fn soul_diagnostics(
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
) -> Result<SoulDiagnostics, String> {
    let conn = db.0.lock().map_err(|_| "storage_unavailable")?;
    Ok(diagnostics::inspect(&conn, boot_ok(&app)))
}

#[tauri::command]
pub fn soul_report_activity(
    window: tauri::WebviewWindow,
    activity_state: State<'_, activity::ActivityState>,
    mut snapshot: ActivitySnapshot,
) -> Result<(), String> {
    if !["bubble", "pet"].contains(&window.label()) {
        return Err("activity_source_invalid".into());
    }
    // Trust the window only for its input state, never for OS or Agent state.
    snapshot.locked = activity::system_locked();
    snapshot.pet_visible = window
        .app_handle()
        .get_webview_window("pet")
        .and_then(|pet| pet.is_visible().ok());
    snapshot.agent_busy = None;
    snapshot.awaiting_confirmation = None;
    activity_state
        .report_from(window.label(), snapshot, now())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn soul_ack_message(
    window: tauri::WebviewWindow,
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
    registry: State<'_, super::proactive::ShownRegistry>,
    receipt: MessageReceipt,
) -> Result<(), String> {
    if !boot_ok(&app) {
        return Err("storage_unavailable".into());
    }
    if window.label() != "bubble" {
        return Err("receipt_source_invalid".into());
    }
    if matches!(receipt.kind, ReceiptKind::Shown) && !window.is_visible().unwrap_or(false) {
        return Err("bubble_hidden".into());
    }
    let mut conn = db.0.lock().map_err(|_| "storage_unavailable")?;
    super::proactive::acknowledge(
        &mut conn,
        &registry,
        &receipt,
        std::time::Instant::now(),
        now(),
    )?;
    if receipt.kind == ReceiptKind::Responded {
        let source = SourceRef {
            kind: "proactive_message".into(),
            id: receipt.message_id.clone(),
            revision: 1,
        };
        super::continuity::record_event(&mut conn, "proactive_responded", &source, now(), now())?;
    }
    Ok(())
}

/// S08 delivery loop: sweeps expiration, applies the gates and hands at most
/// one reserved message to the bubble window per tick.
pub fn start(app: AppHandle) {
    super::notifications::init(&app);
    crate::background::SUPERVISOR.spawn_async("soul-dispatch", move |worker| async move {
        while !worker.cancelled() {
            let attempt_handle = app.clone();
            let attempt =
                tauri::async_runtime::spawn_blocking(move || attempt_dispatch(&attempt_handle))
                    .await
                    .map_err(|error| error.to_string())
                    .and_then(|inner| inner);
            worker.health(attempt.as_ref().map(|_| ()).map_err(Clone::clone));
            if let Ok(Some(message)) = attempt {
                let mut payload = serde_json::json!({
                    "id": message.id,
                    "category": serde_json::to_value(message.category).unwrap(),
                    "templateId": message.template_id,
                    "source": message.source,
                    "text": super::profile::message_text(&crate::settings::read_settings(&app).language,&message.template_id),
                });
                if message.category == ProactiveCategory::Greeting {
                    let db = app.state::<Arc<MemoryDb>>();
                    if let Ok(mut conn) = db.0.lock() {
                        if let Ok(history) = super::continuity::get(&mut conn, now()) {
                            if history.history_enabled {
                                let language = crate::settings::read_settings(&app).language;
                                let days = match language.as_str() {
                                    "en-US" => format!(" Shared day {}.", history.days),
                                    "ja-JP" => format!(" 一緒に記録して{}日目です。", history.days),
                                    _ => format!(" 共同记录第{}天。", history.days),
                                };
                                payload["text"] = serde_json::json!(format!(
                                    "{}{}",
                                    payload["text"].as_str().unwrap_or(""),
                                    days
                                ));
                            }
                        }
                    };
                }
                if let Some(window) = app.get_webview_window("bubble") {
                    if window.show().is_ok()
                        && app.emit_to("bubble", "soul:message", &payload).is_ok()
                    {
                        super::notifications::notify(
                            &message,
                            payload["text"].as_str().unwrap_or(""),
                        );
                    }
                }
            }
            if !worker.sleep(std::time::Duration::from_secs(15)).await { break; }
        }
        Ok(())
    });
}

fn attempt_dispatch(app: &AppHandle) -> Result<Option<ProactiveMessage>, String> {
    if !boot_ok(app) {
        return Ok(None);
    }
    {
        let db = app.state::<Arc<MemoryDb>>();
        let mut conn = db.0.lock().map_err(|_| "storage_unavailable")?;
        diagnostics::check_ledger(&conn)?;
        super::lifecycle::sweep(&mut conn, now())?;
        super::proactive::expire_pending(&mut conn, now())?;
        super::engagement::produce_topics(&mut conn, now())?;
        super::observations::produce_local(&mut conn, now())?;
    }
    let activity_state = app.state::<activity::ActivityState>();
    let settings = crate::settings::read_settings(app);
    let quiet_hours_active = crate::rhythm::is_within_quiet_hours(
        &settings.break_reminder_quiet_hours_start,
        &settings.break_reminder_quiet_hours_end,
        settings.break_reminder_quiet_hours_enabled,
        u64::try_from(now()).unwrap_or(0),
    );
    // Backend-owned signals: agent progress and confirmations are set by the
    // task runtime (S09), never by the UI.
    let agent = app.state::<crate::agent::AgentRuntime>().activity();
    let chat_busy = app
        .state::<crate::runtime_types::ChatRequests>()
        .0
        .try_lock()
        .ok()
        .map(|requests| !requests.is_empty());
    let inputs = activity::GateInputs {
        quiet_mode: Some(settings.quiet_mode.clone()),
        quiet_hours_active,
        idle_seconds: crate::ambient::system_idle_seconds(),
        idle_threshold: Some(crate::ambient::idle_threshold_seconds(&settings.quiet_mode)),
        agent_busy: agent.zip(chat_busy).map(|((busy, _), chat)| busy || chat),
        awaiting_confirmation: agent.map(|(_, waiting)| waiting),
        heartbeat: activity_state.read().map(|(mut snapshot, age)| {
            snapshot.locked = activity::system_locked();
            let bubble_visible = app
                .get_webview_window("bubble")
                .is_some_and(|window| window.is_visible().unwrap_or(false));
            snapshot.typing = if settings.sensing_paused
                || (bubble_visible && !activity_state.source_fresh("bubble"))
            {
                None
            } else {
                activity::keyboard_idle_seconds()
                    .zip(snapshot.typing)
                    .map(|(idle, typing)| typing || idle < 5)
            };
            snapshot.pet_visible = app
                .get_webview_window("pet")
                .and_then(|window| window.is_visible().ok());
            (snapshot, age)
        }),
    };
    if activity_state.returned_from_idle(
        inputs.idle_seconds,
        inputs
            .heartbeat
            .as_ref()
            .and_then(|(snapshot, _)| snapshot.locked),
    ) {
        let db = app.state::<Arc<MemoryDb>>();
        let mut conn = db.0.lock().map_err(|_| "storage_unavailable")?;
        let event_id = format!(
            "return-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "clock_unavailable")?
                .as_nanos()
        );
        super::tasks::queue_greeting(&mut conn, &event_id, now())?;
    }
    if let activity::GateDecision::Blocked(reason) =
        activity::decide(&inputs, activity_state.age_since_last_suppression())
    {
        // Diagnostics carry the skip reason only — no message payloads.
        eprintln!("[soul] dispatch suppressed: {reason}");
        super::notifications::log_gate(reason);
        if reason != "unstable_after_suppression" {
            activity_state.mark_suppressed();
        }
        revoke_visible(app)?;
        return Ok(None);
    }
    // Window queries can synchronously wait for AppKit. A main-thread command
    // may already be waiting for SQLite, so query before taking its mutex.
    let bubble_visible = app
        .get_webview_window("bubble")
        .is_some_and(|window| window.is_visible().unwrap_or(false));
    let db = app.state::<Arc<MemoryDb>>();
    let mut conn = db.0.lock().map_err(|_| "storage_unavailable")?;
    let registry = app.state::<super::proactive::ShownRegistry>();
    if bubble_visible {
        if super::proactive::expire_visible(&mut conn, &registry, now(), std::time::Instant::now())?
            > 0
        {
            drop(conn);
            reconcile_visible(app);
            conn = db.0.lock().map_err(|_| "storage_unavailable")?;
        }
    } else {
        registry
            .0
            .lock()
            .map_err(|_| "storage_unavailable")?
            .clear();
    }
    let cooldown = app.state::<Mutex<super::proactive::Cooldown>>();
    let mut cooldown = cooldown.lock().map_err(|_| "storage_unavailable")?;
    let timezone = iana_time_zone::get_timezone().unwrap_or_else(|_| "unknown".into());
    let clock = super::proactive::DispatchClock {
        unix_now: now(),
        offset_seconds: i64::from(chrono::Local::now().offset().local_minus_utc()),
        timezone,
        monotonic: std::time::Instant::now(),
    };
    super::proactive::reserve(&mut conn, &mut cooldown, clock)
}

#[tauri::command]
pub fn soul_get_profile(
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
    locale: String,
) -> Result<RoleSnapshot, String> {
    Ok(profile::for_request(&app, &db, &locale))
}

#[tauri::command]
pub fn soul_update_profile(
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
    input: UpdateRoleInput,
) -> Result<RoleSnapshot, String> {
    if !boot_ok(&app) {
        return Err("storage_unavailable".into());
    }
    let mut conn = db.0.lock().map_err(|_| "storage_unavailable")?;
    store::ensure_available(&conn).map_err(|_| "storage_unavailable")?;
    let result = profile::update(&mut conn, input, now())?;
    drop(conn);
    // State is committed before notification; a dropped UI listener cannot undo it.
    let _ = app.emit("soul:changed", result.revision);
    Ok(result)
}

#[tauri::command]
pub fn soul_reset_profile(
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
    input: ResetRoleInput,
) -> Result<RoleSnapshot, String> {
    if !boot_ok(&app) {
        return Err("storage_unavailable".into());
    }
    let mut conn = db.0.lock().map_err(|_| "storage_unavailable")?;
    let result = profile::reset(&mut conn, input, now())?;
    drop(conn);
    let _ = app.emit("soul:changed", result.revision);
    Ok(result)
}

#[tauri::command]
pub fn soul_list_open_loop_candidates(
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
) -> Result<OpenLoopReviewQueue, String> {
    if !boot_ok(&app) {
        return Err("storage_unavailable".into());
    }
    let conn = db.0.lock().map_err(|_| "storage_unavailable")?;
    open_loops::pending(&conn)
}

#[tauri::command]
pub fn soul_list_open_loops(
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
    input: Option<ListOpenLoopsInput>,
) -> Result<Vec<OpenLoop>, String> {
    if !boot_ok(&app) {
        return Err("storage_unavailable".into());
    }
    let conn = db.0.lock().map_err(|_| "storage_unavailable")?;
    open_loops::list(&conn, input.and_then(|input| input.state))
}

#[tauri::command]
pub fn soul_update_open_loop(
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
    input: UpdateOpenLoopInput,
) -> Result<OpenLoop, String> {
    if !boot_ok(&app) {
        return Err("storage_unavailable".into());
    }
    let mut conn = db.0.lock().map_err(|_| "storage_unavailable")?;
    let result = open_loops::update(&mut conn, input, now())?;
    drop(conn);
    let _ = app.emit("soul:changed", ());
    let _ = app.emit("memories-updated", ());
    Ok(result)
}

#[tauri::command]
pub fn soul_review_candidate(
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
    input: ReviewOpenLoopInput,
) -> Result<Option<OpenLoop>, String> {
    if !boot_ok(&app) {
        return Err("storage_unavailable".into());
    }
    let mut conn = db.0.lock().map_err(|_| "storage_unavailable")?;
    let result = open_loops::review(&mut conn, input, now())?;
    drop(conn);
    let _ = app.emit("soul:changed", ());
    let _ = app.emit("memories-updated", ());
    Ok(result)
}

pub fn reconcile_visible(app: &AppHandle) {
    let db = app.state::<Arc<MemoryDb>>();
    let ids =
        db.0.lock()
            .ok()
            .and_then(|conn| {
                let mut statement = conn
                .prepare(
                    "SELECT id FROM soul_proactive_ledger WHERE state IN ('dispatching','shown')",
                )
                .ok()?;
                let result = statement
                    .query_map([], |row| row.get::<_, String>(0))
                    .ok()?
                    .collect::<Result<Vec<_>, _>>()
                    .ok();
                result
            })
            .unwrap_or_default();
    super::notifications::reconcile(&ids);
    let _ = app.emit_to("bubble", "soul:active", ids);
}

fn revoke_visible(app: &AppHandle) -> Result<(), String> {
    let db = app.state::<Arc<MemoryDb>>();
    let mut conn = db.0.lock().map_err(|_| "storage_unavailable")?;
    store::transaction(&mut conn, |tx| {
        tx.execute(
            "UPDATE soul_proactive_ledger SET state='revoked',receipt_at=?1 WHERE state='shown'",
            [now()],
        )
        .map_err(|_| "ledger_write_failed")?;
        Ok(())
    })?;
    drop(conn);
    reconcile_visible(app);
    Ok(())
}

#[tauri::command]
pub fn soul_reply_context(
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
    message_id: String,
) -> Result<super::tasks::ReplyContext, String> {
    if !boot_ok(&app) {
        return Err("storage_unavailable".into());
    }
    let conn = db.0.lock().map_err(|_| "storage_unavailable")?;
    super::tasks::reply_context(&conn, &message_id)
}

#[tauri::command]
pub fn soul_resolve_task(
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
    task_id: String,
) -> Result<(), String> {
    if !boot_ok(&app) {
        return Err("storage_unavailable".into());
    }
    let mut conn = db.0.lock().map_err(|_| "storage_unavailable")?;
    super::tasks::resolve(&mut conn, &task_id, now())?;
    drop(conn);
    reconcile_visible(&app);
    Ok(())
}

pub fn open_notification(app: &AppHandle, id: &str) {
    let db = app.state::<Arc<MemoryDb>>();
    let Ok(conn) = db.0.lock() else { return };
    let row=conn.query_row("SELECT category,template_id,source_ref FROM soul_proactive_ledger WHERE id=?1 AND state IN ('dispatching','shown')",[id],|r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)));
    if let Ok((category, template, source)) = row {
        if let Ok(source) = serde_json::from_str::<SourceRef>(&source) {
            let payload = serde_json::json!({"id":id,"category":category,"templateId":template,"source":source,"text":super::profile::message_text(&crate::settings::read_settings(app).language,&template)});
            let _ = app.emit_to("bubble", "soul:message", payload);
        }
    }
}

/// Recover a reserved delivery when its event preceded the bubble's listener.
/// This reads the existing identity; it never reserves or executes another task.
#[tauri::command]
pub fn soul_current_message(
    window: tauri::WebviewWindow,
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
) -> Result<Option<serde_json::Value>, String> {
    if window.label() != "bubble" {
        return Err("message_source_invalid".into());
    }
    if !boot_ok(&app) {
        return Err("storage_unavailable".into());
    }
    let language = crate::settings::read_settings(&app).language;
    let conn = db.0.lock().map_err(|_| "storage_unavailable")?;
    diagnostics::check_ledger(&conn)?;
    current_message(&conn, now(), &language)
}

fn current_message(
    conn: &rusqlite::Connection,
    at: i64,
    language: &str,
) -> Result<Option<serde_json::Value>, String> {
    use rusqlite::OptionalExtension;
    let row = conn.query_row(
        "SELECT l.id,l.category,l.template_id,l.source_ref FROM soul_proactive_ledger l,soul_control c WHERE c.enabled=1 AND c.paused=0 AND l.state IN ('dispatching','shown') AND l.valid_from<=?1 AND l.expires_at>?1 ORDER BY l.dispatching_at DESC,l.id LIMIT 1",
        [at], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?))
    ).optional().map_err(|e|e.to_string())?;
    row.map(|(id, category, template, source)| {
        let source: SourceRef = serde_json::from_str(&source).map_err(|e|e.to_string())?;
        Ok(serde_json::json!({"id":id,"category":category,"templateId":template,"source":source,"text":profile::message_text(language,&template)}))
    }).transpose()
}

#[tauri::command]
pub fn soul_get_mood(
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
) -> Result<super::mood::Mood, String> {
    if !boot_ok(&app) {
        return Err("storage_unavailable".into());
    }
    let mut conn = db.0.lock().map_err(|_| "storage_unavailable")?;
    super::mood::snapshot(&mut conn, now())
}

#[tauri::command]
pub fn soul_list_topic_responses(
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
) -> Result<Vec<super::engagement::TopicResponse>, String> {
    if !boot_ok(&app) {
        return Err("storage_unavailable".into());
    }
    let conn = db.0.lock().map_err(|_| "storage_unavailable")?;
    super::engagement::responses(&conn)
}
#[tauri::command]
pub fn soul_review_topic_response(
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
    id: String,
    approve: bool,
) -> Result<(), String> {
    if !boot_ok(&app) {
        return Err("storage_unavailable".into());
    }
    let mut conn = db.0.lock().map_err(|_| "storage_unavailable")?;
    super::engagement::review_response(&mut conn, &id, approve, now())?;
    drop(conn);
    reconcile_visible(&app);
    let _ = app.emit("memories-updated", ());
    Ok(())
}

#[tauri::command]
pub fn soul_get_continuity(
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
) -> Result<super::continuity::Continuity, String> {
    if !boot_ok(&app) {
        return Err("storage_unavailable".into());
    }
    let mut conn = db.0.lock().map_err(|_| "storage_unavailable")?;
    super::continuity::get(&mut conn, now())
}
#[tauri::command]
pub fn soul_update_continuity(
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
    expected_revision: i64,
    history_enabled: bool,
    nickname: Option<String>,
) -> Result<super::continuity::Continuity, String> {
    if !boot_ok(&app) {
        return Err("storage_unavailable".into());
    }
    let mut conn = db.0.lock().map_err(|_| "storage_unavailable")?;
    super::continuity::update(
        &mut conn,
        expected_revision,
        history_enabled,
        nickname,
        now(),
    )?;
    let updated = super::continuity::get(&mut conn, now())?;
    drop(conn);
    reconcile_visible(&app);
    let _ = app.emit("soul:changed", ());
    Ok(updated)
}
#[tauri::command]
pub fn soul_review_evolution(
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
    id: String,
    approve: bool,
    expected_revision: i64,
    locale: String,
) -> Result<(), String> {
    if !boot_ok(&app) {
        return Err("storage_unavailable".into());
    }
    let mut conn = db.0.lock().map_err(|_| "storage_unavailable")?;
    super::continuity::review_evolution(
        &mut conn,
        &id,
        approve,
        expected_revision,
        &locale,
        now(),
    )?;
    drop(conn);
    let _ = app.emit("soul:changed", ());
    Ok(())
}
#[tauri::command]
pub fn soul_rollback_evolution(
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
    id: String,
    expected_revision: i64,
) -> Result<(), String> {
    if !boot_ok(&app) {
        return Err("storage_unavailable".into());
    }
    let mut conn = db.0.lock().map_err(|_| "storage_unavailable")?;
    super::continuity::rollback(&mut conn, &id, expected_revision, now())?;
    drop(conn);
    let _ = app.emit("soul:changed", ());
    Ok(())
}
#[tauri::command]
pub fn soul_preview_visibility(
    app: AppHandle,
    window: tauri::WebviewWindow,
    db: State<'_, Arc<MemoryDb>>,
    id: String,
    visible: bool,
) -> Result<(), String> {
    if !boot_ok(&app) {
        return Ok(());
    }
    let visible = visible
        && window.is_visible().unwrap_or(false)
        && window.is_focused().unwrap_or(false)
        && activity::system_locked() == Some(false);
    let mut conn = db.0.lock().map_err(|_| "storage_unavailable")?;
    let registry = app.state::<super::observations::PreviewVisibility>();
    super::observations::visible(
        &mut conn,
        &registry,
        &id,
        window.label(),
        visible,
        now(),
        std::time::Instant::now(),
    )
}

#[tauri::command]
pub fn soul_clear_category(
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
    category: ProactiveCategory,
    expected_revision: i64,
) -> Result<SoulSettings, String> {
    if !boot_ok(&app) {
        return Err("storage_unavailable".into());
    }
    let mut conn = db.0.lock().map_err(|_| "storage_unavailable")?;
    settings::clear_category(&mut conn, category, expected_revision, now())?;
    let result = settings::get(&mut conn, now())?;
    drop(conn);
    reconcile_visible(&app);
    Ok(result)
}

#[tauri::command]
pub async fn soul_request_notification_permission(
    window: tauri::WebviewWindow,
) -> Result<bool, String> {
    if window.label() != "panel" {
        return Err("permission_source_invalid".into());
    }
    super::notifications::request_permission().await
}

#[cfg(test)]
mod delivery_recovery_tests {
    use super::*;

    #[test]
    fn recovery_preserves_identity_without_reserving_and_obeys_control_and_expiry() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        store::migrate(&mut conn).unwrap();
        settings::get(&mut conn, 100).unwrap();
        conn.execute("UPDATE soul_control SET enabled=1", [])
            .unwrap();
        conn.execute("INSERT INTO soul_proactive_ledger(id,category,source_ref,dedupe_key,template_id,valid_from,expires_at,state,created_at,dispatching_at) VALUES('m','task_unresolved',?1,'d','task_interrupted',100,200,'dispatching',100,100)",
            [r#"{"kind":"agent_task","id":"task","revision":1}"#]).unwrap();
        let message = current_message(&conn, 150, "zh-CN").unwrap().unwrap();
        assert_eq!(message["id"], "m");
        assert_eq!(message["source"]["id"], "task");
        assert_eq!(
            conn.query_row("SELECT state FROM soul_proactive_ledger", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "dispatching"
        );
        assert!(current_message(&conn, 200, "zh-CN").unwrap().is_none());
        conn.execute("UPDATE soul_control SET paused=1", [])
            .unwrap();
        assert!(current_message(&conn, 150, "zh-CN").unwrap().is_none());
        conn.execute("UPDATE soul_control SET paused=0,enabled=0", [])
            .unwrap();
        assert!(current_message(&conn, 150, "zh-CN").unwrap().is_none());
    }
}
