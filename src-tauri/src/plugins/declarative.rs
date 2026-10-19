//! External plugin discovery, manifest validation and declarative/WASI execution.
use super::{PikoPlugin, PluginManifest};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeclarativePluginPackage {
    #[serde(flatten)]
    pub(crate) manifest: PluginManifest,
    #[serde(default)]
    pub(crate) responses: HashMap<String, Value>,
    #[serde(default)]
    pub(crate) runtime: Option<String>,
    #[serde(default)]
    pub(crate) module: Option<String>,
}

pub(crate) struct DeclarativePlugin {
    pub(crate) package: DeclarativePluginPackage,
    pub(crate) directory: PathBuf,
}

pub(crate) struct ExternalPluginPackage {
    pub(crate) directory: PathBuf,
    pub(crate) package: DeclarativePluginPackage,
}

impl PikoPlugin for DeclarativePlugin {
    fn manifest(&self) -> PluginManifest {
        self.package.manifest.clone()
    }

    fn execute(&self, app: &AppHandle, tool: &str, input: Value) -> Result<Value, String> {
        match self.package.runtime.as_deref() {
            Some("wasm") => execute_wasm_plugin(app, &self.directory, &self.package, tool, input),
            _ => self
                .package
                .responses
                .get(tool)
                .cloned()
                .ok_or_else(|| "声明式插件未配置该工具的响应".to_string()),
        }
    }
}

pub(crate) fn read_external_plugin_packages(app: &AppHandle) -> Vec<ExternalPluginPackage> {
    let Some(directory) = external_plugins_path(app) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path().join("manifest.json");
            fs::read_to_string(path)
                .ok()
                .and_then(|json| serde_json::from_str::<DeclarativePluginPackage>(&json).ok())
                .map(|package| ExternalPluginPackage {
                    directory: entry.path(),
                    package,
                })
        })
        .collect()
}

pub(crate) fn validate_declarative_plugin(
    package: &DeclarativePluginPackage,
) -> Result<(), String> {
    if !package.manifest.id.starts_with("piko.external.") || package.manifest.id.contains("..") {
        return Err("外部插件 ID 必须以 piko.external. 开头".to_string());
    }
    if package.manifest.tools.is_empty() {
        return Err("外部插件必须声明至少一个工具".to_string());
    }
    let runtime = package.runtime.as_deref().unwrap_or("declarative");
    if !matches!(runtime, "declarative" | "wasm") {
        return Err("外部插件 runtime 仅支持 declarative 或 wasm".to_string());
    }
    if runtime == "wasm" && package.module.as_deref().unwrap_or("").is_empty() {
        return Err("WASM 插件必须指定 module 文件".to_string());
    }
    if runtime == "wasm" && !cfg!(feature = "wasm-plugins") {
        return Err("此构建未启用 WASM 插件".into());
    }
    if runtime == "wasm" {
        let module = package.module.as_deref().unwrap_or("");
        if Path::new(module).is_absolute()
            || Path::new(module)
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err("WASM 模块路径不能越过插件目录".into());
        }
        if !module.ends_with(".wasm") {
            return Err("WASM 插件 module 必须以 .wasm 结尾".to_string());
        }
    }
    for tool in &package.manifest.tools {
        if runtime == "declarative"
            && (!matches!(tool.risk.as_str(), "pure" | "read") || tool.confirmation != "never")
        {
            return Err("声明式插件只允许 pure/read 且无需确认的工具".to_string());
        }
        if runtime == "wasm"
            && !matches!(tool.risk.as_str(), "pure" | "read" | "write" | "sensitive")
        {
            return Err("WASM 插件工具风险等级不合法".to_string());
        }
        if runtime == "declarative" && !package.responses.contains_key(&tool.name) {
            return Err(format!("工具 {} 缺少静态响应", tool.name));
        }
    }
    Ok(())
}

pub(crate) fn execute_wasm_plugin(
    _app: &AppHandle,
    directory: &Path,
    package: &DeclarativePluginPackage,
    tool: &str,
    input: Value,
) -> Result<Value, String> {
    let module_name = package.module.as_deref().unwrap_or("plugin.wasm");
    let plugin_id = package.manifest.id.clone();
    let manifest = package.manifest.clone();

    let stdin_payload = serde_json::to_vec(&json!({
        "pluginId": plugin_id,
        "toolName": tool,
        "arguments": input,
        "manifest": manifest,
    }))
    .map_err(|e| e.to_string())?;
    let (stdout_text, stderr_text) =
        super::wasm_runtime::execute(directory, module_name, stdin_payload)?;
    let output = stdout_text.trim();
    if output.is_empty() {
        return Ok(json!({
            "ok": true,
            "pluginId": plugin_id.clone(),
            "toolName": tool,
            "stderr": stderr_text,
        }));
    }

    match serde_json::from_str::<Value>(output) {
        Ok(value) => Ok(value),
        Err(_) => Ok(json!({
            "ok": true,
            "pluginId": plugin_id,
            "toolName": tool,
            "stderr": stderr_text,
            "raw": output,
        })),
    }
}

pub(crate) fn external_plugins_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("plugins"))
}
