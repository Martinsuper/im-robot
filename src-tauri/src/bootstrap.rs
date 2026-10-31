//! Application composition, command registration and startup lifecycle.
use crate::actions;
use crate::actions::ActionDrafts;
use crate::agent;
use crate::ambient::watch_ambient_nudges;
use crate::ambient::watch_foreground_app;
use crate::ambient::watch_idle_detection;
use crate::ambient::IdleDetection;
use crate::app_awareness;
use crate::app_updates;
use crate::attachments;
use crate::attachments::TextAttachmentStore;
use crate::calendar_service;
use crate::calendar_service::watch_calendar_events;
use crate::calendar_service::CalendarNotificationCache;
use crate::chat;
use crate::chat_session;
use crate::chat_session::repository::migrate_chat_sessions;
use crate::companion;
use crate::credentials;
use crate::desktop;
#[cfg(target_os = "macos")]
use crate::desktop::configure_application_menu;
use crate::desktop::configure_global_shortcut;
use crate::desktop::configure_tray;
use crate::desktop::enable_bubble_background_drag;
use crate::desktop::enable_pet_background_drag;
use crate::desktop::open_panel;
use crate::desktop::restore_bubble_size;
use crate::desktop::restore_pet_position;
use crate::desktop::show_bubble;
use crate::desktop::show_pet_on_startup;
use crate::desktop::watch_bubble_resize;
use crate::desktop::watch_panel_close;
use crate::desktop::watch_pet_position;
use crate::desktop::GlobalShortcutState;
use crate::desktop::PetContextMenu;
use crate::desktop::TrayIconHandle;
use crate::desktop::TrayState;
use crate::favorites;
use crate::html_preview;
use crate::memory;
use crate::memos;
use crate::plugins;
use crate::plugins::PluginRegistry;
use crate::providers;
use crate::reminder_service;
use crate::reminder_service::watch_reminders;
use crate::rhythm;
use crate::rhythm::watch_focus_timer;
use crate::rhythm::watch_work_rhythm;
use crate::rhythm::FocusTimer;
use crate::rhythm::WorkRhythmCache;
use crate::rhythm::WorkRhythmReminderCache;
use crate::runtime_types::ChatContext;
use crate::runtime_types::ChatRequests;
use crate::schedule;
use crate::schedule::repository::migrate_schedule_items;
use crate::screen_capture;
use crate::screen_capture::ScreenCaptureStore;
use crate::settings;
use crate::settings::persist_settings;
use crate::settings::read_settings;
use crate::speech;
use crate::speech::LocalTts;
use crate::typing_activity;
use crate::{awareness_commands, data_commands, sync};
use std::sync::Arc;
use std::sync::Mutex;
use tauri::{Listener, Manager};
use tauri_plugin_autostart::MacosLauncher;

pub(crate) fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            desktop::open_panel(app.clone(), None);
        }))
        .manage(html_preview::HtmlPreviewStore::default())
        .register_uri_scheme_protocol("preview", |context, request| {
            html_preview::response(context.app_handle(), request.uri().path())
        })
        .manage(ChatRequests::default())
        .manage(ChatContext::default())
        .manage(agent::AgentRuntime::default())
        .manage(crate::conversation_windows::ConversationWindows::default())
        .manage(crate::conversation_views::ConversationViews::default())
        .manage(PluginRegistry::with_builtin_plugins())
        .manage(ActionDrafts::default())
        .manage(LocalTts::default())
        .manage(FocusTimer::default())
        .manage(crate::devices::DeviceBridge::default())
        .manage(IdleDetection::default())
        .manage(PetContextMenu::default())
        .manage(WorkRhythmCache::default())
        .manage(WorkRhythmReminderCache::default())
        .manage(CalendarNotificationCache::default())
        .manage(TextAttachmentStore::default())
        .manage(ScreenCaptureStore::default())
        .manage(app_awareness::ForegroundAppState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let workspace_app = app.handle().clone();
            app.listen("workspace-ready", move |_| {
                desktop::replay_workspace_request(&workspace_app)
            });
            app.listen("workspace-visibility", move |event| {
                desktop::set_workspace_visible(event.payload() == "true")
            });
            crate::data_snapshot::recover_before_start(app.handle())?;
            credentials::initialize(app.path().app_data_dir()?)?;
            for config in &app.config().app.windows {
                // The panel is now embedded in bubble; keep its URL only for browser previews.
                if config.label == "panel" {
                    continue;
                }
                tauri::WebviewWindowBuilder::from_config(app.handle(), config)?
                    .on_navigation(html_preview::local_preview_navigation)
                    .build()?;
            }
            // 初始化记忆数据库失败时降级到进程内数据库，避免阻断应用启动；
            // 同时记录并通知用户，明确说明记忆不会持久化。
            let mut memory_persistent = true;
            let memory_db = match memory::init_memory_db(app.handle()) {
                Ok(db) => db,
                Err(error) => {
                    memory_persistent = false;
                    eprintln!("[memory] 持久化数据库初始化失败，降级为本次会话记忆：{error}");
                    let _ = crate::notifications::send(
                        app.handle(),
                        "记忆功能已降级",
                        &format!("记忆数据库初始化失败，本次启动不会持久化记忆：{error}"),
                    );
                    memory::open_in_memory_db().map_err(|fallback_error| {
                        format!("记忆数据库初始化失败，且无法启用本次会话记忆：{fallback_error}")
                    })?
                }
            };
            app.manage(crate::data_snapshot::MemoryPersistence(memory_persistent));
            app.manage(Arc::new(memory_db));
            app.manage(memory::CandidateCache::default());
            memory::extraction::start(app.handle().clone());
            memory::knowledge::start(app.handle().clone());
            memory::vault::start(app.handle().clone());
            // S08：调度循环自身 fail closed（未启用/未迁移时保持静默）。
            memory::soul::commands::start(app.handle().clone());
            memory::soul::desktop::start(app.handle().clone());
            // S09：启动恢复 interrupted 任务并入队提醒候选与启动问候（均受类别开关门控）。
            memory::soul::tasks::on_boot(app.handle());
            app.manage(typing_activity::TypingActivityState::new(app.handle()));

            // R1：把提醒与日程合并到统一存储。幂等且不删除旧文件；
            // 失败只记录日志，不能让迁移问题阻断应用启动。
            // R4-1：先建托盘拿到菜单项句柄，再交给全局状态，
            // 之后 set_pet_visible() 才能在运行时改「隐藏/显示 Piko」的文案。
            let (tray_toggle, tray_icon) = configure_tray(app)?;
            // 必须持有 TrayIcon：引用计数归零时图标会从菜单栏消失
            app.manage(TrayIconHandle { _icon: tray_icon });
            app.manage(TrayState {
                toggle_label: Mutex::new(tray_toggle),
            });
            app.manage(GlobalShortcutState(Mutex::new(
                read_settings(app.handle()).global_shortcut,
            )));

            match migrate_chat_sessions(app.handle()) {
                Ok(report) if report.already_migrated => {}
                Ok(report) => println!(
                    "[chat] 迁移完成：{} 个会话（来自 {} 轮问答），备份于 {}",
                    report.sessions_imported,
                    report.entries_imported,
                    report
                        .backup_dir
                        .as_deref()
                        .unwrap_or("（无旧文件，未备份）")
                ),
                Err(error) => eprintln!("[chat] 迁移中止：{error}"),
            }

            match migrate_schedule_items(app.handle()) {
                Ok(report) if report.already_migrated => {}
                Ok(report) => println!(
                    "[schedule] 迁移完成：提醒 {} 条、日程 {} 条，备份于 {}",
                    report.reminders_imported,
                    report.events_imported,
                    report
                        .backup_dir
                        .as_deref()
                        .unwrap_or("（无旧文件，未备份）")
                ),
                Err(error) => eprintln!("[schedule] 迁移中止：{error}"),
            }

            #[cfg(target_os = "macos")]
            configure_application_menu(app)?;
            configure_global_shortcut(app)?;
            app.state::<PluginRegistry>()
                .register_declarative_plugins(app.handle());
            let settings = read_settings(app.handle());
            persist_settings(app.handle(), &settings)?;
            if let Ok(mut paused) = app
                .state::<app_awareness::ForegroundAppState>()
                .sensing_paused
                .lock()
            {
                *paused = settings.sensing_paused;
            }
            if !settings.onboarding_completed {
                open_panel(app.handle().clone(), Some("today".into()));
            }
            restore_pet_position(app.handle());
            show_pet_on_startup(app.handle());
            watch_pet_position(app.handle());
            restore_bubble_size(app.handle());
            watch_bubble_resize(app.handle());
            watch_panel_close(app.handle());
            enable_pet_background_drag(app.handle());
            enable_bubble_background_drag(app.handle());
            watch_reminders(app.handle());
            // P2 §9：定时委托的 SUPERVISOR 轮询线程（自适应到期轮询 + 崩溃对账）。
            crate::scheduled_tasks::watch_scheduled_tasks(app.handle());
            watch_calendar_events(app.handle());
            watch_focus_timer(app.handle());
            watch_ambient_nudges(app.handle());
            app.handle()
                .on_menu_event(|app_handle, event| match event.id.as_ref() {
                    "pet_ctx_chat" => show_bubble(app_handle.clone()),
                    "pet_ctx_panel" => open_panel(app_handle.clone(), None),
                    "pet_ctx_hide" => desktop::hide_pet(app_handle.clone()),
                    "pet_ctx_quit" => app_handle.exit(0),
                    _ => {}
                });
            watch_idle_detection(app.handle());
            watch_foreground_app(app.handle());
            typing_activity::start_keyboard_monitor(app.handle());
            typing_activity::watch_typing_rollover(app.handle());
            watch_work_rhythm(app.handle());
            crate::conversation_windows::restore(app.handle());
            crate::devices::restore_device_bridge(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            crate::notifications::get_notification_status,
            crate::notifications::request_notification_permission,
            crate::notifications::send_test_notification,
            crate::notifications::open_notification_settings,
            plugins::commands::list_business_plugins,
            plugins::commands::list_external_plugins,
            plugins::commands::list_provider_tools,
            html_preview::open_html_preview_window,
            html_preview::create_html_preview_frame,
            html_preview::remove_html_preview_frame,
            desktop::show_bubble,
            desktop::hide_bubble,
            desktop::toggle_bubble,
            desktop::open_panel,
            desktop::toggle_panel,
            desktop::show_pet,
            desktop::hide_pet,
            desktop::show_pet_context_menu,
            screen_capture::begin_screen_capture,
            screen_capture::cancel_screen_capture,
            screen_capture::confirm_screen_capture,
            screen_capture::get_screen_capture_preview,
            screen_capture::clear_screen_capture,
            desktop::move_pet,
            desktop::move_pet_relative,
            desktop::get_pet_position,
            settings::commands::get_settings,
            crate::devices::get_device_status,
            crate::devices::start_device_bridge,
            crate::devices::stop_device_bridge,
            crate::devices::begin_device_pairing,
            crate::devices::forget_device,
            crate::devices::publish_device_pet,
            screen_capture::screen_capture_permission_status,
            crate::background::background_status,
            crate::data_snapshot::get_data_health,
            crate::data_snapshot::create_data_snapshot,
            crate::data_snapshot::preview_data_snapshot,
            crate::data_snapshot::restore_data_snapshot,
            crate::pet_state::get_pet_state,
            crate::pet_state::save_pet_state,
            crate::pet_state::migrate_pet_state,
            app_updates::check_for_updates,
            app_updates::check_for_updates_extended,
            chat_session::commands::list_chat_history,
            chat_session::commands::list_chat_sessions,
            chat_session::commands::delete_chat_session,
            desktop::update_global_shortcut,
            desktop::get_global_shortcut,
            data_commands::clear_my_data,
            chat_session::commands::clear_chat_history,
            chat_session::commands::clear_chat_context,
            speech::speak_local_text,
            speech::stop_local_speech,
            rhythm::get_focus_state,
            rhythm::get_typing_stats_today,
            rhythm::get_work_rhythm_state,
            rhythm::start_focus,
            rhythm::start_break,
            rhythm::pause_focus,
            rhythm::resume_focus,
            rhythm::stop_focus,
            reminder_service::commands::list_reminders,
            schedule::commands::list_schedule_items,
            schedule::commands::complete_schedule_item,
            reminder_service::commands::create_reminder,
            reminder_service::commands::delete_reminder,
            memos::commands::list_memos,
            memos::commands::create_memo,
            memos::commands::update_memo,
            memos::commands::delete_memo,
            memos::commands::summarize_memos,
            favorites::list_html_favorites,
            favorites::create_html_favorite,
            favorites::delete_html_favorite,
            calendar_service::commands::list_calendar_events,
            calendar_service::commands::create_calendar_event,
            calendar_service::commands::delete_calendar_event,
            calendar_service::commands::export_calendar_events,
            calendar_service::commands::open_calendar_import,
            actions::commands::confirm_chat_action,
            actions::commands::reject_chat_action,
            attachments::prepare_text_attachment,
            attachments::clear_text_attachment,
            attachments::save_generated_text,
            settings::commands::update_quiet_mode,
            settings::commands::update_language,
            settings::commands::update_preferences,
            rhythm::update_work_rhythm_preferences,
            settings::commands::update_ai_settings,
            crate::tts::get_speech_output_settings,
            crate::tts::update_speech_output_settings,
            speech::get_speech_model_status,
            speech::download_speech_model,
            speech::transcribe_voice_input,
            settings::commands::update_html_preview_enabled,
            settings::commands::update_agent_auto_approve_commands,
            companion::generate_pet_companion_response,
            providers::commands::list_models,
            agent::agent_start,
            agent::agent_list_tasks,
            agent::agent_get_task_snapshot,
            agent::agent_get_task_snapshots,
            crate::conversation_windows::conversation_list_windows,
            crate::conversation_windows::conversation_open_window,
            crate::conversation_windows::conversation_close_window,
            crate::conversation_views::conversation_get_view,
            crate::conversation_views::conversation_save_view,
            crate::conversation_views::conversation_chat_history,
            crate::conversation_views::conversation_forget_view,
            crate::conversation_views::conversation_delete,
            agent::agent_get_diagnostics,
            agent::agent_read_task_log,
            agent::agent_get_task_steps,
            crate::scheduled_tasks::scheduled_task_list,
            crate::scheduled_tasks::scheduled_task_create,
            crate::scheduled_tasks::scheduled_task_cancel,
            memory::vault::memory_vault_status,
            memory::vault::memory_vault_open_directory,
            memory::vault::memory_vault_configure,
            memory::vault::memory_vault_sync,
            memory::vault::memory_vault_preview,
            memory::vault::memory_vault_resolve,
            memory::maintenance::knowledge_get_maintenance_status,
            memory::maintenance::knowledge_configure_maintenance,
            memory::maintenance::knowledge_maintain,
            memory::knowledge::knowledge_get_settings,
            memory::knowledge::knowledge_save_settings,
            memory::knowledge::knowledge_list_documents,
            memory::knowledge::knowledge_import,
            memory::knowledge::knowledge_delete_document,
            memory::knowledge::knowledge_search,
            memory::knowledge::knowledge_reindex,
            memory::knowledge::memory_revisions,
            memory::knowledge::memory_get_provenance,
            memory::knowledge::supersede_memory,
            memory::soul::commands::soul_diagnostics,
            memory::soul::commands::soul_report_activity,
            memory::soul::commands::soul_ack_message,
            memory::soul::commands::soul_current_message,
            memory::soul::commands::soul_reply_context,
            memory::soul::commands::soul_resolve_task,
            memory::soul::commands::soul_get_settings,
            memory::soul::desktop::soul_get_desktop_settings,
            memory::soul::desktop::soul_desktop_status,
            memory::soul::desktop::soul_test_desktop_model,
            memory::soul::desktop::soul_test_desktop_speech,
            memory::soul::desktop::soul_update_desktop_settings,
            memory::soul::commands::soul_get_mood,
            memory::soul::commands::soul_request_notification_permission,
            memory::soul::commands::soul_clear_category,
            memory::soul::commands::soul_get_continuity,
            memory::soul::commands::soul_update_continuity,
            memory::soul::commands::soul_review_evolution,
            memory::soul::commands::soul_rollback_evolution,
            memory::soul::commands::soul_preview_visibility,
            memory::soul::commands::soul_list_topic_responses,
            memory::soul::commands::soul_review_topic_response,
            memory::soul::commands::soul_update_settings,
            memory::soul::commands::soul_clear,
            memory::soul::commands::soul_get_profile,
            memory::soul::commands::soul_update_profile,
            memory::soul::commands::soul_reset_profile,
            memory::soul::commands::soul_list_open_loop_candidates,
            memory::soul::commands::soul_list_open_loops,
            memory::soul::commands::soul_update_open_loop,
            memory::soul::commands::soul_review_candidate,
            agent::agent_select_workspace,
            agent::agent_confirm_action,
            agent::agent_reject_action,
            agent::agent_cancel,
            agent::agent_approve,
            agent::agent_steer,
            agent::agent_confirm_contract,
            crate::project_registry::project_list,
            crate::project_registry::project_create,
            crate::project_registry::project_update,
            crate::project_registry::project_delete,
            chat::chat_start,
            chat::chat_cancel,
            chat_session::commands::get_bubble_chat_history,
            settings::commands::get_onboarding_status,
            settings::commands::complete_onboarding,
            settings::commands::skip_onboarding,
            settings::commands::reset_onboarding,
            awareness_commands::get_foreground_app_state,
            awareness_commands::toggle_foreground_sensing,
            data_commands::export_data,
            data_commands::export_to_file,
            data_commands::preview_import,
            data_commands::import_data,
            sync::commands::get_calendar_sync_status,
            sync::commands::sync_calendar_to_system,
            sync::commands::sync_calendar_from_system,
            app_updates::download_update_asset,
            app_updates::cancel_update_download,
            // Memory system (Phase 1)
            memory::list_memories,
            memory::get_memory_detail,
            memory::create_memory,
            memory::update_memory,
            memory::delete_memory,
            memory::clear_memories,
            // Memory system (Phase 2: retrieval & management)
            memory::search_memories,
            memory::search_related_memories,
            memory::get_recent_memories,
            memory::build_memory_context,
            memory::pin_memory,
            memory::unpin_memory,
            memory::feedback_memory,
            memory::add_memory_relation,
            memory::remove_memory_relation,
            memory::get_memory_relations,
            // Memory system (Phase 3+: writer, reflection, maintenance, import/export)
            memory::extraction::get_memory_extraction_status,
            memory::extraction::configure_memory_extraction,
            memory::extraction::extract_memories_now,
            memory::capture_memory_candidates,
            memory::get_pending_candidates,
            memory::apply_memory_candidates,
            memory::reject_memory_candidate,
            memory::reflect_memory_now,
            memory::get_memory_summaries,
            memory::merge_memories_cmd,
            memory::get_merge_candidates,
            memory::abstract_semantic_from_events,
            memory::expire_old_memories,
            memory::recalculate_confidence,
            memory::export_memories,
            memory::memory_preview_import,
            memory::import_memories
        ])
        .build(tauri::generate_context!())
        .expect("error while building Piko desktop application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                crate::conversation_windows::prepare_exit(app);
            }
            if matches!(event, tauri::RunEvent::Exit) {
                crate::conversation_windows::prepare_exit(app);
                if let Some(tts) = app.try_state::<LocalTts>() {
                    if let Ok(mut cancel) = tts.1.try_lock() {
                        if let Some(cancel) = cancel.take() {
                            cancel.cancel();
                        }
                    }
                    if let Ok(mut active) = tts.0.try_lock() {
                        drop(active.take());
                    }
                }
                let closing = app.clone();
                crate::background::SUPERVISOR.spawn_effect("shutdown-flush", move |_| {
                    if let Some(state) = closing.try_state::<typing_activity::TypingActivityState>()
                    {
                        let now = crate::common::unix_timestamp();
                        let _ = state.finalize_stale_session(&closing, now);
                        let _ = state.flush_snapshot_if_needed(&closing, now);
                    }
                });
                let unfinished =
                    crate::background::SUPERVISOR.shutdown(std::time::Duration::from_secs(3));
                if !unfinished.is_empty() {
                    eprintln!("[shutdown] workers did not finish: {unfinished:?}");
                }
            }
        });
}
