use crate::types::{ActionDraft, ActionExecution, PluginManifest, PluginRegistry, PluginToolManifest, PluginManifest as _, PikoPlugin};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::AppHandle;

#[derive(Default)]
pub struct ActionDrafts(pub std::sync::Mutex<HashMap<String, ActionDraft>>);
