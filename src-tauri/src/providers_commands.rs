//! Desktop model discovery command; provider transport stays independent of Tauri.
use super::{
    extract_model_ids, http_client, models_url, request_builder, validate_ai_settings, ModelInfo,
};
use crate::settings::read_settings;
use serde_json::Value;
use tauri::AppHandle;

#[tauri::command]
pub(crate) async fn list_models(app: AppHandle) -> Result<Vec<ModelInfo>, String> {
    let settings = read_settings(&app);
    validate_ai_settings(&settings.ai)?;
    let client = http_client(&settings.ai)?;
    let response = request_builder(
        &client,
        &settings.ai,
        reqwest::Method::GET,
        models_url(&settings.ai),
    )?
    .send()
    .await
    .map_err(|error| error.to_string())?
    .error_for_status()
    .map_err(|error| error.to_string())?;
    let body = response
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;

    Ok(extract_model_ids(&settings.ai.provider, &body)
        .into_iter()
        .map(|id| ModelInfo { id })
        .collect())
}
