//! Exact-operation authorization and deterministic entity IDs for crash-safe local mutations.
use crate::plugins::PluginRegistry;
use crate::plugins::ToolCall;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{cell::RefCell, collections::BTreeMap};
use tauri::{AppHandle, Manager};

struct Scope {
    key: String,
    counters: BTreeMap<String, u64>,
    reconcile_only: bool,
}
thread_local! { static SCOPE: RefCell<Option<Scope>> = const { RefCell::new(None) }; }
struct Reset(Option<Scope>);
impl Drop for Reset {
    fn drop(&mut self) {
        SCOPE.with(|scope| *scope.borrow_mut() = self.0.take());
    }
}
fn scoped<T>(key: &str, action: impl FnOnce() -> T) -> T {
    scoped_mode(key, false, action)
}
fn scoped_mode<T>(key: &str, reconcile_only: bool, action: impl FnOnce() -> T) -> T {
    let previous = SCOPE.with(|scope| {
        scope.borrow_mut().replace(Scope {
            key: key.into(),
            counters: BTreeMap::new(),
            reconcile_only,
        })
    });
    let _reset = Reset(previous);
    action()
}
pub fn may_create() -> bool {
    SCOPE.with(|scope| {
        scope
            .borrow()
            .as_ref()
            .is_none_or(|scope| !scope.reconcile_only)
    })
}
pub fn next_id(kind: &str) -> Option<String> {
    SCOPE.with(|scope| {
        let mut scope = scope.borrow_mut();
        let scope = scope.as_mut()?;
        let index = scope.counters.entry(kind.into()).or_default();
        let id = format!(
            "{kind}-piko-{:x}",
            Sha256::digest(format!("{}:{kind}:{index}", scope.key))
        );
        *index += 1;
        Some(id)
    })
}
pub fn supported(plugin: &str, tool: &str) -> bool {
    matches!(
        (plugin, tool),
        ("piko.memos", "create_memo")
            | ("piko.reminders", "create_reminder" | "delete_reminder")
            | (
                "piko.calendar",
                "create_event" | "create_event_batch" | "delete_event" | "delete_event_batch"
            )
    )
}
pub fn key(root: &str, call: &ToolCall) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!(
            "{root}:{}:{}:{}",
            call.plugin_id, call.tool_name, call.arguments
        ))
    )
}
fn path(app: &AppHandle, key: &str) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("agent/native-operations")
        .join(format!("{key}.json")))
}
fn generation(app: &AppHandle, root: &str) -> Result<String, String> {
    let state: Value = crate::storage::read(&path(
        app,
        &format!("{:x}.generation", Sha256::digest(root)),
    )?)?;
    Ok(state["epoch"].as_str().unwrap_or("initial").to_string())
}
pub fn revoke(app: &AppHandle, root: &str) -> Result<(), String> {
    crate::storage::write(
        &path(app, &format!("{:x}.generation", Sha256::digest(root)))?,
        &json!({"epoch":crate::reminder_service::reminder_id()}),
    )
}
pub fn authorized(app: &AppHandle, key: &str, root: &str) -> Result<bool, String> {
    let state: Value = crate::storage::read(&path(app, key)?)?;
    Ok(state["authorized"].as_bool() == Some(true)
        && state["epoch"].as_str().unwrap_or("initial") == generation(app, root)?)
}

pub fn authorize(app: &AppHandle, key: &str, plugin: &str, root: &str) -> Result<(), String> {
    let before = fingerprint(&current(app, plugin)?);
    crate::storage::write(
        &path(app, key)?,
        &json!({"authorized":true,"before":before,"completed":false,"epoch":generation(app, root)?}),
    )
}
fn fingerprint(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string()))
}
pub fn completed(app: &AppHandle, key: &str) -> Result<(), String> {
    let file = path(app, key)?;
    let mut state: Value = crate::storage::read(&file)?;
    state["completed"] = json!(true);
    crate::storage::write(&file, &state)
}
pub fn current(app: &AppHandle, plugin: &str) -> Result<Value, String> {
    match plugin {
        "piko.memos" => {
            let file = crate::memos::memos_path(app).ok_or("无法获取备忘录路径")?;
            let items: Vec<crate::memos::Memo> = crate::storage::read(&file)?;
            serde_json::to_value(items).map_err(|error| error.to_string())
        }
        "piko.reminders" => serde_json::to_value(crate::schedule::reminders_view(
            &crate::schedule::repository::load_schedule_items(app, false)?,
        ))
        .map_err(|error| error.to_string()),
        "piko.calendar" => serde_json::to_value(crate::schedule::calendar_view(
            &crate::schedule::repository::load_schedule_items(app, false)?,
        ))
        .map_err(|error| error.to_string()),
        _ => Err("该插件没有本地验收适配器".into()),
    }
}

// A known authorized deletion is satisfied by absence. Never try to re-delete a stale ID.
fn reconcile_deletions(call: &mut ToolCall, current: &Value) -> Vec<Value> {
    let exists = |id: &str| {
        current
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["id"].as_str() == Some(id)))
    };
    if call.tool_name.ends_with("_batch") {
        let mut absent = Vec::new();
        if let Some(events) = call.arguments["events"].as_array_mut() {
            events.retain(|event| {
                let id = event["id"].as_str().unwrap_or("");
                if exists(id) {
                    true
                } else {
                    absent.push(json!({"id":id,"alreadyAbsent":true}));
                    false
                }
            });
        }
        absent
    } else {
        let id = call.arguments["id"].as_str().unwrap_or("");
        if !id.is_empty() && !exists(id) {
            vec![json!({"id":id,"alreadyAbsent":true})]
        } else {
            Vec::new()
        }
    }
}
pub fn execute(
    app: &AppHandle,
    registry: &PluginRegistry,
    mut call: ToolCall,
    key: &str,
    replay: bool,
) -> Result<(Value, bool), String> {
    let _transaction = crate::storage::transaction();
    let state: Value = crate::storage::read(&path(app, key)?)?;
    let plugin = call.plugin_id.clone();
    let actual = current(app, &plugin)?;
    let reconcile_only = replay
        && (state["completed"].as_bool() == Some(true)
            || state["before"].as_str() != Some(&fingerprint(&actual)));
    let batch = call.tool_name.ends_with("_batch");
    let stored = if replay && call.tool_name.starts_with("delete_") {
        current(app, &call.plugin_id)?
    } else {
        Value::Null
    };
    let absent = if replay && call.tool_name.starts_with("delete_") {
        reconcile_deletions(&mut call, &stored)
    } else {
        Vec::new()
    };
    if !absent.is_empty()
        && (!batch
            || call.arguments["events"]
                .as_array()
                .is_some_and(Vec::is_empty))
    {
        completed(app, key)?;
        return Ok((
            if batch {
                json!(absent)
            } else {
                absent[0].clone()
            },
            true,
        ));
    }
    if reconcile_only && call.tool_name.starts_with("delete_") {
        return Err("删除目标或相关记录在检查点后发生变化，请先核对并提出新的操作要求".into());
    }
    let mut result = scoped_mode(key, reconcile_only, || registry.execute(app, call))?;
    if let Some(items) = result.as_array_mut() {
        items.extend(absent);
    }
    completed(app, key)?;
    let reused = fingerprint(&actual) == fingerprint(&current(app, &plugin)?);
    Ok((result, reused))
}
pub fn with_authorized_scope<T>(key: &str, action: impl FnOnce() -> T) -> T {
    scoped(key, action)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn calendar_checkpoint_reconciles_the_same_entity_and_rejects_external_changes() {
        let start = crate::common::unix_timestamp() + 86400;
        let make_input = || crate::calendar_service::CalendarEventInput {
            title: "评审".into(),
            start_at: start,
            end_at: start + 3600,
            location: None,
            notes: None,
        };
        let (first, created) = scoped("operation", || {
            crate::calendar_service::checkpoint_calendar_event(&[], make_input())
        })
        .unwrap();
        assert!(created);
        let (again, created) = scoped_mode("operation", true, || {
            crate::calendar_service::checkpoint_calendar_event(std::slice::from_ref(&first), make_input())
        })
        .unwrap();
        assert!(!created);
        assert_eq!(first, again);
        let mut changed = first;
        changed.title = "用户已修改".into();
        assert!(
            scoped_mode("operation", true, || crate::calendar_service::checkpoint_calendar_event(
                &[changed],
                make_input()
            ))
            .is_err()
        );
        assert!(
            scoped_mode("operation", true, || crate::calendar_service::checkpoint_calendar_event(
                &[],
                make_input()
            ))
            .is_err()
        );
    }

    #[test]
    fn repeated_operation_scopes_get_the_same_ids_but_distinct_batch_items() {
        let first = scoped("operation", || {
            vec![next_id("event").unwrap(), next_id("event").unwrap()]
        });
        let resumed = scoped("operation", || {
            vec![next_id("event").unwrap(), next_id("event").unwrap()]
        });
        assert_eq!(first, resumed);
        assert_ne!(first[0], first[1]);
        assert!(next_id("event").is_none());
        assert_ne!(
            first[0],
            scoped("another-operation", || next_id("event").unwrap())
        );
    }
    #[test]
    fn mixed_batch_deletions_only_retry_ids_still_present() {
        let mut call = ToolCall {
            plugin_id: "piko.calendar".into(),
            tool_name: "delete_event_batch".into(),
            arguments: json!({"events":[{"id":"old"},{"id":"present"}]}),
        };
        let absent = reconcile_deletions(&mut call, &json!([{"id":"present"}]));
        assert_eq!(call.arguments["events"], json!([{"id":"present"}]));
        assert_eq!(absent, vec![json!({"id":"old","alreadyAbsent":true})]);
    }
}
