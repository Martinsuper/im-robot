use crate::types::{
    CalendarEvent, CalendarEventInput, CalendarDeleteInput, DeclarativePluginPackage,
    InstalledPlugin, PikoPlugin, PluginManifest, PluginToolManifest, Reminder, ReminderDeleteInput,
    ReminderInput, ToolCall,
};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

// --- DeclarativePlugin ---

pub struct DeclarativePlugin {
    pub package: DeclarativePluginPackage,
}

impl PikoPlugin for DeclarativePlugin {
    fn manifest(&self) -> PluginManifest {
        self.package.manifest.clone()
    }

    fn execute(&self, _app: &AppHandle, tool: &str, _input: Value) -> Result<Value, String> {
        self.package
            .responses
            .get(tool)
            .cloned()
            .ok_or_else(|| "声明式插件未配置该工具的响应".to_string())
    }
}

// --- ReminderPlugin ---

struct ReminderPlugin;

impl ReminderPlugin {
    fn tool_manifests() -> Vec<PluginToolManifest> {
        vec![
            PluginToolManifest {
                name: "list_reminders".to_string(),
                description: "列出全部本地提醒，供查询和删除前定位目标".to_string(),
                input_schema: json!({ "type": "object", "properties": {} }),
                risk: "read".to_string(),
                confirmation: "never".to_string(),
            },
            PluginToolManifest {
                name: "create_reminder".to_string(),
                description: "创建一条本地提醒".to_string(),
                input_schema: json!({
                    "type": "object",
                    "required": ["title", "dueAt"],
                    "properties": {
                        "title": { "type": "string", "maxLength": 120 },
                        "dueAt": { "type": "string", "description": "ISO 8601 时间，例如 2026-06-02T15:00:00+08:00" },
                        "repeat": { "enum": ["none", "daily", "weekly", "weekdays"] }
                    }
                }),
                risk: "write".to_string(),
                confirmation: "always".to_string(),
            },
            PluginToolManifest {
                name: "delete_reminder".to_string(),
                description: "删除一条本地提醒，必须先确认目标提醒".to_string(),
                input_schema: json!({
                    "type": "object",
                    "required": ["id"],
                    "properties": {
                        "id": { "type": "string", "description": "提醒 ID" },
                        "title": { "type": "string", "description": "用于确认展示的提醒标题" },
                        "dueAt": { "type": "string", "description": "用于确认展示的提醒时间" },
                        "repeat": { "enum": ["none", "daily", "weekly", "weekdays"] }
                    }
                }),
                risk: "sensitive".to_string(),
                confirmation: "always".to_string(),
            },
        ]
    }
}

impl PikoPlugin for ReminderPlugin {
    fn manifest(&self) -> PluginManifest {
        PluginManifest {
            id: "piko.reminders".to_string(),
            name: "提醒事项".to_string(),
            version: "1.0.0".to_string(),
            description: "创建和管理本地提醒".to_string(),
            tools: Self::tool_manifests(),
        }
    }

    fn execute(&self, app: &AppHandle, tool: &str, input: Value) -> Result<Value, String> {
        match tool {
            "list_reminders" => {
                serde_json::to_value(read_reminders(app)).map_err(|error| error.to_string())
            }
            "create_reminder" => {
                let reminder_input = reminder_input_from_value(&input)?;
                let reminder = create_reminder_record(app, reminder_input)?;
                serde_json::to_value(reminder).map_err(|error| error.to_string())
            }
            "delete_reminder" => {
                let deleted =
                    delete_reminder_record(app, reminder_delete_input_from_value(&input)?)?;
                serde_json::to_value(deleted).map_err(|error| error.to_string())
            }
            _ => Err("提醒插件不支持该工具".to_string()),
        }
    }
}

// --- CalendarPlugin ---

struct CalendarPlugin;

impl CalendarPlugin {
    fn tool_manifests() -> Vec<PluginToolManifest> {
        vec![
            PluginToolManifest {
                name: "list_events".to_string(),
                description: "列出全部本地日程，供查询和删除前定位目标".to_string(),
                input_schema: json!({ "type": "object", "properties": {} }),
                risk: "read".to_string(),
                confirmation: "never".to_string(),
            },
            PluginToolManifest {
                name: "detect_conflicts".to_string(),
                description: "检查时间段是否与已有日程冲突".to_string(),
                input_schema: json!({
                    "type": "object",
                    "required": ["startAt", "endAt"],
                    "properties": {
                        "startAt": { "type": "string", "description": "ISO 8601 时间" },
                        "endAt": { "type": "string", "description": "ISO 8601 时间" }
                    }
                }),
                risk: "read".to_string(),
                confirmation: "never".to_string(),
            },
            PluginToolManifest {
                name: "create_event".to_string(),
                description: "创建一条本地日程".to_string(),
                input_schema: json!({
                    "type": "object",
                    "required": ["title", "startAt", "endAt"],
                    "properties": {
                        "title": { "type": "string", "maxLength": 120 },
                        "startAt": { "type": "string", "description": "ISO 8601 时间，例如 2026-06-02T15:00:00+08:00" },
                        "endAt": { "type": "string", "description": "ISO 8601 时间，例如 2026-06-02T16:00:00+08:00" },
                        "location": { "type": "string" },
                        "notes": { "type": "string" }
                    }
                }),
                risk: "write".to_string(),
                confirmation: "always".to_string(),
            },
            PluginToolManifest {
                name: "create_event_batch".to_string(),
                description: "批量创建本地日程，适合日程规划；整批需要用户确认".to_string(),
                input_schema: json!({
                    "type": "object",
                    "required": ["events"],
                    "properties": {
                        "events": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 20,
                            "items": {
                                "type": "object",
                                "required": ["title", "startAt", "endAt"],
                                "properties": {
                                    "title": { "type": "string", "maxLength": 120 },
                                    "startAt": { "type": "string", "description": "ISO 8601 时间，例如 2026-06-02T15:00:00+08:00" },
                                    "endAt": { "type": "string", "description": "ISO 8601 时间，例如 2026-06-02T16:00:00+08:00" },
                                    "location": { "type": "string" },
                                    "notes": { "type": "string" }
                                }
                            }
                        }
                    }
                }),
                risk: "write".to_string(),
                confirmation: "always".to_string(),
            },
            PluginToolManifest {
                name: "delete_event".to_string(),
                description: "删除一条本地日程，必须先确认目标日程".to_string(),
                input_schema: json!({
                    "type": "object",
                    "required": ["id"],
                    "properties": {
                        "id": { "type": "string", "description": "日程 ID" },
                        "title": { "type": "string", "description": "用于确认展示的日程标题" },
                        "startAt": { "type": "string", "description": "用于确认展示的日程开始时间" },
                        "endAt": { "type": "string", "description": "用于确认展示的日程结束时间" }
                    }
                }),
                risk: "sensitive".to_string(),
                confirmation: "always".to_string(),
            },
        ]
    }
}

impl PikoPlugin for CalendarPlugin {
    fn manifest(&self) -> PluginManifest {
        PluginManifest {
            id: "piko.calendar".to_string(),
            name: "日程规划".to_string(),
            version: "1.0.0".to_string(),
            description: "创建、读取和检查本地日程".to_string(),
            tools: Self::tool_manifests(),
        }
    }

    fn execute(&self, app: &AppHandle, tool: &str, input: Value) -> Result<Value, String> {
        match tool {
            "list_events" => {
                serde_json::to_value(read_calendar_events(app)).map_err(|error| error.to_string())
            }
            "detect_conflicts" => {
                let start_at = tool_timestamp(&input["startAt"])?;
                let end_at = tool_timestamp(&input["endAt"])?;
                serde_json::to_value(find_calendar_conflicts(
                    &read_calendar_events(app),
                    start_at,
                    end_at,
                ))
                .map_err(|error| error.to_string())
            }
            "create_event" => {
                let event_input = calendar_event_input_from_value(&input)?;
                let event = create_calendar_event_record(app, event_input)?;
                serde_json::to_value(event).map_err(|error| error.to_string())
            }
            "create_event_batch" => {
                let batch = calendar_event_batch_input_from_value(&input)?;
                let events = create_calendar_event_batch_record(app, batch)?;
                serde_json::to_value(events).map_err(|error| error.to_string())
            }
            "delete_event" => {
                let deleted =
                    delete_calendar_event_record(app, calendar_delete_input_from_value(&input)?)?;
                serde_json::to_value(deleted).map_err(|error| error.to_string())
            }
            _ => Err("日程插件不支持该工具".to_string()),
        }
    }
}

// --- PluginRegistry ---

pub struct PluginRegistry {
    pub plugins: Mutex<HashMap<String, Arc<dyn PikoPlugin>>>,
}

impl PluginRegistry {
    pub fn with_builtin_plugins() -> Self {
        let reminder_plugin: Arc<dyn PikoPlugin> = Arc::new(ReminderPlugin);
        let calendar_plugin: Arc<dyn PikoPlugin> = Arc::new(CalendarPlugin);
        let mut plugins = HashMap::new();
        plugins.insert(reminder_plugin.manifest().id, reminder_plugin);
        plugins.insert(calendar_plugin.manifest().id, calendar_plugin);
        Self {
            plugins: Mutex::new(plugins),
        }
    }

    pub fn manifests(&self) -> Vec<PluginManifest> {
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

    pub fn execute(&self, app: &AppHandle, call: ToolCall) -> Result<Value, String> {
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

    pub fn tool_manifest(&self, call: &ToolCall) -> Result<PluginToolManifest, String> {
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

    pub fn decode_tool_call(&self, wire_name: &str, arguments: Value) -> Result<ToolCall, String> {
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

    pub fn register_declarative_plugins(&self, app: &AppHandle) -> Vec<InstalledPlugin> {
        let packages = read_external_plugin_packages(app);
        let mut plugins = match self.plugins.lock() {
            Ok(plugins) => plugins,
            Err(_) => return Vec::new(),
        };
        let mut installed = Vec::new();
        for package in packages {
            let error = validate_declarative_plugin(&package).err();
            let executable = error.is_none();
            let status = error.unwrap_or_else(|| "已启用声明式只读运行时".to_string());
            if executable && !plugins.contains_key(&package.manifest.id) {
                plugins.insert(
                    package.manifest.id.clone(),
                    Arc::new(DeclarativePlugin {
                        package: package.clone(),
                    }),
                );
            }
            installed.push(InstalledPlugin {
                manifest: package.manifest,
                executable,
                status,
            });
        }
        installed.sort_by(|left, right| left.manifest.id.cmp(&right.manifest.id));
        installed
    }
}

fn plugin_wire_name(plugin_id: &str, tool_name: &str) -> String {
    format!("{}__{tool_name}", plugin_id.replace('.', "_"))
}

fn read_external_plugin_packages(app: &AppHandle) -> Vec<DeclarativePluginPackage> {
    let Some(directory) = external_plugins_path(app) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path().join("manifest.json");
            std::fs::read_to_string(path)
                .ok()
                .and_then(|json| serde_json::from_str::<DeclarativePluginPackage>(&json).ok())
        })
        .collect()
}

fn external_plugins_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("plugins"))
}

fn validate_declarative_plugin(package: &DeclarativePluginPackage) -> Result<(), String> {
    if !package.manifest.id.starts_with("piko.external.") || package.manifest.id.contains("..") {
        return Err("外部插件 ID 必须以 piko.external. 开头".to_string());
    }
    if package.manifest.tools.is_empty() {
        return Err("外部插件必须声明至少一个工具".to_string());
    }
    for tool in &package.manifest.tools {
        if !matches!(tool.risk.as_str(), "pure" | "read") || tool.confirmation != "never" {
            return Err("声明式插件只允许 pure/read 且无需确认的工具".to_string());
        }
        if !package.responses.contains_key(&tool.name) {
            return Err(format!("工具 {} 缺少静态响应", tool.name));
        }
    }
    Ok(())
}

use serde_json::json;
use std::path::Path;

// --- Reminder/Calendar record operations (moved from lib.rs) ---

fn read_reminders(app: &AppHandle) -> Vec<Reminder> {
    reminders_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn reminders_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("reminders.json"))
}

fn persist_reminders(app: &AppHandle, reminders: &[Reminder]) -> Result<(), String> {
    let path = reminders_path(app).ok_or_else(|| "无法获取提醒记录路径".to_string())?;
    let directory = path
        .parent()
        .ok_or_else(|| "无法获取提醒记录目录".to_string())?;
    let json = serde_json::to_string(reminders).map_err(|error| error.to_string())?;

    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    std::fs::write(path, json).map_err(|error| error.to_string())
}

fn read_calendar_events(app: &AppHandle) -> Vec<CalendarEvent> {
    calendar_events_path(app)
        .map(|path| read_calendar_events_from_path(&path))
        .unwrap_or_default()
}

fn read_calendar_events_from_path(path: &Path) -> Vec<CalendarEvent> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn calendar_events_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("calendar-events.json"))
}

fn persist_calendar_events(app: &AppHandle, events: &[CalendarEvent]) -> Result<(), String> {
    let path = calendar_events_path(app).ok_or_else(|| "无法获取日程记录路径".to_string())?;
    persist_calendar_events_to_path(&path, events)
}

fn persist_calendar_events_to_path(path: &Path, events: &[CalendarEvent]) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| "无法获取日程记录目录".to_string())?;
    let json = serde_json::to_string(events).map_err(|error| error.to_string())?;

    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    std::fs::write(path, json).map_err(|error| error.to_string())
}

fn tool_timestamp(value: &Value) -> Result<u64, String> {
    if let Some(timestamp) = value.as_u64() {
        return Ok(timestamp);
    }

    let raw = value
        .as_str()
        .ok_or_else(|| "时间必须是 ISO 8601 字符串".to_string())?;
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(raw) {
        return u64::try_from(parsed.timestamp()).map_err(|_| "时间不能早于 1970 年".to_string());
    }

    let parsed = chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S"))
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M"))
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M"))
        .map_err(|_| "时间必须是 ISO 8601 格式".to_string())?;
    let parsed = chrono::Local
        .from_local_datetime(&parsed)
        .single()
        .ok_or_else(|| "本地时间无效，请提供带时区的 ISO 8601 时间".to_string())?;
    u64::try_from(parsed.timestamp()).map_err(|_| "时间不能早于 1970 年".to_string())
}

fn reminder_input_from_value(value: &Value) -> Result<ReminderInput, String> {
    let title = value["title"]
        .as_str()
        .ok_or_else(|| "提醒标题不能为空".to_string())?
        .to_string();
    let due_at = tool_timestamp(&value["dueAt"])?;
    let repeat = value["repeat"].as_str().unwrap_or("none").to_string();
    Ok(ReminderInput {
        title,
        due_at,
        repeat,
    })
}

fn calendar_event_input_from_value(value: &Value) -> Result<CalendarEventInput, String> {
    let title = value["title"]
        .as_str()
        .ok_or_else(|| "日程标题不能为空".to_string())?
        .to_string();
    let start_at = tool_timestamp(&value["startAt"])?;
    let end_at = tool_timestamp(&value["endAt"])?;
    let location = value["location"].as_str().map(str::to_string);
    let notes = value["notes"].as_str().map(str::to_string);
    Ok(CalendarEventInput {
        title,
        start_at,
        end_at,
        location,
        notes,
    })
}

fn calendar_event_batch_input_from_value(value: &Value) -> Result<CalendarEventBatchInput, String> {
    use crate::types::CalendarEventBatchInput;
    let events = value["events"]
        .as_array()
        .ok_or_else(|| "批量日程必须包含 events 数组".to_string())?;
    if events.is_empty() || events.len() > 20 {
        return Err("批量日程数量必须在 1 到 20 之间".to_string());
    }
    Ok(CalendarEventBatchInput {
        events: events
            .iter()
            .map(calendar_event_input_from_value)
            .collect::<Result<Vec<_>, _>>()?,
    })
}

fn reminder_delete_input_from_value(value: &Value) -> Result<ReminderDeleteInput, String> {
    let id = value["id"]
        .as_str()
        .ok_or_else(|| "提醒 ID 不能为空".to_string())?
        .to_string();
    Ok(ReminderDeleteInput {
        id,
        title: value["title"].as_str().map(str::to_string),
        due_at: value["dueAt"]
            .as_str()
            .and_then(|text| tool_timestamp_str(text)),
        repeat: value["repeat"].as_str().map(str::to_string),
    })
}

fn calendar_delete_input_from_value(value: &Value) -> Result<CalendarDeleteInput, String> {
    let id = value["id"]
        .as_str()
        .ok_or_else(|| "日程 ID 不能为空".to_string())?
        .to_string();
    Ok(CalendarDeleteInput {
        id,
        title: value["title"].as_str().map(str::to_string),
        start_at: value["startAt"]
            .as_str()
            .and_then(|text| tool_timestamp_str(text)),
        end_at: value["endAt"]
            .as_str()
            .and_then(|text| tool_timestamp_str(text)),
    })
}

fn tool_timestamp_str(value: &str) -> Option<u64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date_time| date_time.timestamp().max(0) as u64)
}

fn create_reminder_record(
    app: &AppHandle,
    input: ReminderInput,
) -> Result<Reminder, String> {
    let id = reminder_id();
    let reminder = Reminder {
        id,
        title: input.title,
        due_at: input.due_at,
        status: "pending".to_string(),
        repeat: input.repeat,
    };
    let mut reminders = read_reminders(app);
    reminders.push(reminder.clone());
    persist_reminders(app, &reminders)?;
    Ok(reminder)
}

fn delete_reminder_record(
    app: &AppHandle,
    input: ReminderDeleteInput,
) -> Result<Reminder, String> {
    let mut reminders = read_reminders(app);
    let index = reminders
        .iter()
        .position(|r| r.id == input.id)
        .ok_or_else(|| "未找到该提醒".to_string())?;
    let reminder = reminders.remove(index);
    persist_reminders(app, &reminders)?;
    Ok(reminder)
}

fn find_calendar_conflicts(
    events: &[CalendarEvent],
    start_at: u64,
    end_at: u64,
) -> Vec<CalendarEvent> {
    events
        .iter()
        .filter(|event| event.start_at < end_at && start_at < event.end_at)
        .cloned()
        .collect()
}

fn calendar_conflict_note(existing_events: &[CalendarEvent], start_at: u64, end_at: u64) -> Option<String> {
    let conflicts = find_calendar_conflicts(existing_events, start_at, end_at);
    if conflicts.is_empty() {
        return None;
    }
    let formatted = conflicts
        .iter()
        .map(|event| {
            let start = format_tool_timestamp(Some(event.start_at)).unwrap_or_else(|| "时间无效".to_string());
            let end = format_tool_timestamp(Some(event.end_at)).unwrap_or_else(|| "时间无效".to_string());
            format!("• {}：{} - {}", event.title, start, end)
        })
        .collect::<Vec<_>>()
        .join("\n");
    Some(format!("注意：以下日程与已有日程时间重叠：\n{}", formatted))
}

fn calendar_event_from_input(input: CalendarEventInput) -> Result<CalendarEvent, String> {
    if input.start_at >= input.end_at {
        return Err("日程开始时间必须早于结束时间".to_string());
    }
    Ok(CalendarEvent {
        id: calendar_event_id(),
        title: input.title,
        start_at: input.start_at,
        end_at: input.end_at,
        location: input.location,
        notes: input.notes,
    })
}

fn create_calendar_event_record(
    app: &AppHandle,
    input: CalendarEventInput,
) -> Result<CalendarEvent, String> {
    let event = calendar_event_from_input(input)?;
    let mut events = read_calendar_events(app);
    let conflict_note = calendar_conflict_note(&events, event.start_at, event.end_at);
    events.push(event.clone());
    persist_calendar_events(app, &events)?;
    if let Some(note) = conflict_note {
        eprintln!("{note}");
    }
    Ok(event)
}

fn create_calendar_event_record_at_path(
    path: &Path,
    input: CalendarEventInput,
) -> Result<CalendarEvent, String> {
    let event = calendar_event_from_input(input)?;
    let events = read_calendar_events_from_path(path);
    let mut events = events;
    events.push(event.clone());
    persist_calendar_events_to_path(path, &events)?;
    Ok(event)
}

fn create_calendar_event_batch_record(
    app: &AppHandle,
    batch: CalendarEventBatchInput,
) -> Result<Vec<CalendarEvent>, String> {
    use crate::types::CalendarEventBatchInput;
    let mut events = read_calendar_events(app);
    let mut created = Vec::new();
    for input in batch.events {
        let event = calendar_event_from_input(input)?;
        events.push(event.clone());
        created.push(event);
    }
    persist_calendar_events(app, &events)?;
    Ok(created)
}

fn delete_calendar_event_record(
    app: &AppHandle,
    input: CalendarDeleteInput,
) -> Result<CalendarEvent, String> {
    let mut events = read_calendar_events(app);
    let index = events
        .iter()
        .position(|e| e.id == input.id)
        .ok_or_else(|| "未找到该日程".to_string())?;
    let event = events.remove(index);
    persist_calendar_events(app, &events)?;
    Ok(event)
}

fn format_tool_timestamp(value: Option<u64>) -> Option<String> {
    value.and_then(|timestamp| {
        chrono::Local
            .timestamp_opt(timestamp as i64, 0)
            .single()
            .map(|date_time| date_time.format("%Y-%m-%d %H:%M").to_string())
    })
}

fn repeat_rule_label(repeat: &str) -> &str {
    match repeat {
        "daily" => "每天",
        "weekly" => "每周",
        "weekdays" => "工作日",
        _ => "仅一次",
    }
}

fn default_repeat_rule() -> String {
    "none".to_string()
}

fn reminder_id() -> String {
    format!(
        "reminder-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

fn calendar_event_id() -> String {
    format!(
        "calendar-event-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}
