//! Plugin registry and shared tool contracts. Business writes remain behind the existing approval flow.
pub(crate) mod bridge;
mod builtins;
#[cfg(feature = "wasm-plugins")]
mod wasm_runtime;
#[cfg(not(feature = "wasm-plugins"))]
mod wasm_runtime {
    pub(super) fn execute(
        _: &std::path::Path,
        _: &str,
        _: Vec<u8>,
    ) -> Result<(String, String), String> {
        Err("此构建未启用 WASM 插件".into())
    }
}
pub(crate) mod commands;
pub(crate) mod declarative;
#[cfg(test)]
mod tests;

#[cfg(test)]
pub(crate) use builtins::calendar_events_tool_result;
use builtins::{CalendarPlugin, MemoPlugin, ReminderPlugin};
use declarative::{read_external_plugin_packages, validate_declarative_plugin, DeclarativePlugin};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::AppHandle;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginToolManifest {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) input_schema: Value,
    pub(crate) risk: String,
    pub(crate) confirmation: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginManifest {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) version: String,
    pub(crate) description: String,
    pub(crate) tools: Vec<PluginToolManifest>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstalledPlugin {
    pub(crate) manifest: PluginManifest,
    pub(crate) executable: bool,
    pub(crate) status: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolCall {
    pub(crate) plugin_id: String,
    pub(crate) tool_name: String,
    pub(crate) arguments: Value,
}

pub(crate) trait PikoPlugin: Send + Sync {
    fn manifest(&self) -> PluginManifest;
    fn execute(&self, app: &AppHandle, tool: &str, input: Value) -> Result<Value, String>;
}

pub(crate) struct PluginRegistry {
    plugins: Mutex<HashMap<String, Arc<dyn PikoPlugin>>>,
}

impl PluginRegistry {
    pub(crate) fn with_builtin_plugins() -> Self {
        let reminder_plugin: Arc<dyn PikoPlugin> = Arc::new(ReminderPlugin);
        let memo_plugin: Arc<dyn PikoPlugin> = Arc::new(MemoPlugin);
        let calendar_plugin: Arc<dyn PikoPlugin> = Arc::new(CalendarPlugin);
        let mut plugins = HashMap::new();
        plugins.insert(reminder_plugin.manifest().id, reminder_plugin);
        plugins.insert(memo_plugin.manifest().id, memo_plugin);
        plugins.insert(calendar_plugin.manifest().id, calendar_plugin);
        Self {
            plugins: Mutex::new(plugins),
        }
    }

    pub(crate) fn manifests(&self) -> Vec<PluginManifest> {
        let Ok(plugins) = self.plugins.lock() else {
            return Vec::new();
        };
        let mut manifests = plugins
            .values()
            .map(|plugin| plugin.manifest())
            .collect::<Vec<_>>();
        manifests.sort_by(|left, right| left.id.cmp(&right.id));
        manifests
    }

    pub(crate) fn execute(&self, app: &AppHandle, call: ToolCall) -> Result<Value, String> {
        let plugins = self
            .plugins
            .lock()
            .map_err(|_| "无法读取业务插件".to_string())?;
        let plugin = plugins
            .get(&call.plugin_id)
            .ok_or_else(|| "未找到对应的业务插件".to_string())?;
        let manifest = plugin.manifest();
        if !manifest
            .tools
            .iter()
            .any(|tool| tool.name == call.tool_name)
        {
            return Err("插件未声明该工具".to_string());
        }
        plugin.execute(app, &call.tool_name, call.arguments)
    }

    pub(crate) fn tool_manifest(&self, call: &ToolCall) -> Result<PluginToolManifest, String> {
        self.plugins
            .lock()
            .map_err(|_| "无法读取业务插件".to_string())?
            .get(&call.plugin_id)
            .ok_or_else(|| "未找到对应的业务插件".to_string())?
            .manifest()
            .tools
            .into_iter()
            .find(|tool| tool.name == call.tool_name)
            .ok_or_else(|| "插件未声明该工具".to_string())
    }

    pub(crate) fn decode_tool_call(
        &self,
        wire_name: &str,
        arguments: Value,
    ) -> Result<ToolCall, String> {
        for manifest in self.manifests() {
            for tool in manifest.tools {
                if plugin_wire_name(&manifest.id, &tool.name) == wire_name {
                    return Ok(ToolCall {
                        plugin_id: manifest.id,
                        tool_name: tool.name,
                        arguments,
                    });
                }
            }
        }
        Err("模型请求了未注册的工具".to_string())
    }

    pub(crate) fn register_declarative_plugins(&self, app: &AppHandle) -> Vec<InstalledPlugin> {
        let packages = read_external_plugin_packages(app);
        let mut plugins = match self.plugins.lock() {
            Ok(plugins) => plugins,
            Err(_) => return Vec::new(),
        };
        let mut installed = Vec::new();
        for package in packages {
            let error = validate_declarative_plugin(&package.package).err();
            let executable = error.is_none();
            let runtime = package.package.runtime.as_deref().unwrap_or("declarative");
            let status = error.unwrap_or_else(|| match runtime {
                "wasm" => "已启用 WASM 沙箱运行时".to_string(),
                _ => "已启用声明式只读运行时".to_string(),
            });
            if executable && !plugins.contains_key(&package.package.manifest.id) {
                plugins.insert(
                    package.package.manifest.id.clone(),
                    Arc::new(DeclarativePlugin {
                        package: package.package.clone(),
                        directory: package.directory.clone(),
                    }),
                );
            }
            installed.push(InstalledPlugin {
                manifest: package.package.manifest,
                executable,
                status,
            });
        }
        installed.sort_by(|left, right| left.manifest.id.cmp(&right.manifest.id));
        installed
    }
}

pub(crate) fn plugin_wire_name(plugin_id: &str, tool_name: &str) -> String {
    format!("{}__{tool_name}", plugin_id.replace('.', "_"))
}
