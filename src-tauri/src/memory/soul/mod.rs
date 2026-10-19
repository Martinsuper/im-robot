//! Versioned local soul state. No timers or delivery are enabled by this module.
pub mod model;
pub mod store;

pub mod activity;
pub mod commands;
pub mod diagnostics;
pub mod open_loops;
pub mod proactive;
pub mod profile;
pub mod settings;
pub mod tasks;

pub mod lifecycle;

pub mod notifications;

pub mod mood;

pub mod continuity;
pub mod engagement;
pub mod observations;
