//! Read/discovery command facade. Approval and business execution stay in the existing command layer.
use super::bridge::provider_tools;
use super::{InstalledPlugin, PluginManifest, PluginRegistry};
use serde_json::Value;
use tauri::{AppHandle, State};

#[tauri::command]
pub(crate) fn list_business_plugins(registry: State<'_, PluginRegistry>) -> Vec<PluginManifest> {
    registry.manifests()
}

#[tauri::command]
pub(crate) fn list_external_plugins(
    app: AppHandle,
    registry: State<'_, PluginRegistry>,
) -> Vec<InstalledPlugin> {
    registry.register_declarative_plugins(&app)
}

#[tauri::command]
pub(crate) fn list_provider_tools(provider: String, registry: State<'_, PluginRegistry>) -> Value {
    provider_tools(&provider, &registry.manifests())
}
