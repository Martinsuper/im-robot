//! Rust owns durable pet state. Browser storage is only a one-time migration source and preview cache.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use tauri::{AppHandle, Emitter, Manager};
const KEYS: &[&str] = &[
    "piko-interaction-stats",
    "piko-pet-growth-state",
    "piko-personality-state",
];
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    pub revision: u64,
    pub value: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PetState {
    pub schema_version: u32,
    pub initialized: bool,
    pub entries: BTreeMap<String, Entry>,
}
impl Default for PetState {
    fn default() -> Self {
        Self {
            schema_version: 1,
            initialized: false,
            entries: BTreeMap::new(),
        }
    }
}
pub(crate) fn empty_initialized() -> PetState {
    PetState {
        initialized: true,
        entries: KEYS
            .iter()
            .map(|k| {
                (
                    (*k).into(),
                    Entry {
                        revision: 1,
                        value: None,
                    },
                )
            })
            .collect(),
        ..Default::default()
    }
}
fn path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("pet-state.json"))
}
#[tauri::command]
pub(crate) fn get_pet_state(app: AppHandle) -> Result<PetState, String> {
    crate::storage::read(&path(&app)?)
}
#[tauri::command]
pub(crate) fn migrate_pet_state(
    app: AppHandle,
    legacy: BTreeMap<String, String>,
) -> Result<PetState, String> {
    let _transaction = crate::storage::transaction();
    let path = path(&app)?;
    let mut state: PetState = crate::storage::read(&path)?;
    if !state.initialized {
        state = empty_initialized();
        for (key, value) in legacy {
            validate(&key, Some(&value))?;
            state.entries.insert(
                key,
                Entry {
                    revision: 1,
                    value: Some(value),
                },
            );
        }
        crate::storage::write(&path, &state)?;
    }
    Ok(state)
}
#[tauri::command]
pub(crate) fn save_pet_state(
    app: AppHandle,
    key: String,
    value: Option<String>,
    expected_revision: u64,
    origin: String,
) -> Result<Entry, String> {
    let _transaction = crate::storage::transaction();
    let path = path(&app)?;
    let mut state: PetState = crate::storage::read(&path)?;
    if !state.initialized {
        return Err("宠物数据尚未完成初始化".into());
    }
    let entry = save(&mut state, &key, value, expected_revision)?;
    crate::storage::write(&path, &state)?;
    let _ = app.emit(
        "pet-state-updated",
        serde_json::json!({"key":key,"entry":entry,"origin":origin}),
    );
    Ok(entry)
}
fn validate(key: &str, value: Option<&str>) -> Result<(), String> {
    if !KEYS.contains(&key) {
        return Err(crate::error_codes::PET_STATE_KEY_INVALID.into());
    }
    if let Some(text) = value {
        if text.len() > 1024 * 1024 {
            return Err(crate::error_codes::PET_STATE_TOO_LARGE.into());
        }
        let value: Value =
            serde_json::from_str(text).map_err(|_| crate::error_codes::PET_STATE_INVALID_JSON)?;
        if !value.is_object() {
            return Err(crate::error_codes::PET_STATE_INVALID_SHAPE.into());
        }
    }
    Ok(())
}
fn save(
    state: &mut PetState,
    key: &str,
    value: Option<String>,
    expected: u64,
) -> Result<Entry, String> {
    validate(key, value.as_deref())?;
    let revision = state.entries.get(key).map_or(0, |entry| entry.revision);
    if revision != expected {
        return Err("宠物状态已在其他窗口更新，请重试此次操作".into());
    }
    let entry = Entry {
        revision: revision
            .checked_add(1)
            .ok_or("pet_state_revision_overflow")?,
        value,
    };
    state.entries.insert(key.into(), entry.clone());
    Ok(entry)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_updates_cannot_overwrite_another_window() {
        let mut state = empty_initialized();
        save(&mut state, KEYS[0], Some("{}".into()), 1).unwrap();
        assert!(save(&mut state, KEYS[0], Some("{\"lost\":true}".into()), 1).is_err());
        assert_eq!(state.entries[KEYS[0]].value.as_deref(), Some("{}"));
        assert!(save(&mut state, "../bad", None, 0).is_err());
    }
}
