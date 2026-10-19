mod ambient;
mod app_updates;
mod attachments;
mod awareness_commands;
mod calendar_service;
mod common;
mod companion;
mod data_commands;
mod data_gate;
mod data_snapshot;
mod desktop;
mod favorites;
mod html_preview;
mod memos;
mod notifications;
mod pet_state;
mod reminder_service;
mod runtime_types;
mod screen_capture;
mod speech;

mod actions;
mod agent;
mod agent_operations;
pub mod app_awareness;
mod app_settings;
mod chat;
mod chat_session;
mod chat_stream;
mod credentials;
mod debounce;
pub mod memory;
mod plugins;
mod providers;
mod reminder_schedule;
mod rhythm;
mod schedule;
mod settings;
mod storage;
pub mod sync;
pub mod typing_activity;

mod background;
mod bootstrap;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    bootstrap::run();
}

#[cfg(test)]
mod architecture_tests;
