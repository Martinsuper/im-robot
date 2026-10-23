//! Desktop model discovery command; provider transport stays independent of Tauri.
use super::{
    extract_model_ids, http_client, models_url, provider_kind, request_builder_with_key, ModelInfo,
};
use crate::settings::read_settings;
use serde_json::Value;
use tauri::AppHandle;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelDiscoveryInput {
    provider: String,
    base_url: String,
    api_key: Option<String>,
    use_saved_key: bool,
}

#[tauri::command]
pub(crate) async fn list_models(
    app: AppHandle,
    input: Option<ModelDiscoveryInput>,
) -> Result<Vec<ModelInfo>, String> {
    let settings = read_settings(&app);
    let mut ai = settings.ai.clone();
    let api_key = if let Some(input) = input {
        // A draft endpoint must never inherit another connection's saved credential.
        let same_connection = input.provider == ai.provider
            && super::normalize_base_url(&input.base_url)
                == super::normalize_base_url(&ai.base_url);
        ai.provider = input.provider;
        ai.base_url = input.base_url.trim().to_string();
        match input.api_key.filter(|key| !key.trim().is_empty()) {
            Some(key) => Some(key),
            None if input.use_saved_key && same_connection => crate::credentials::read_api_key()?,
            None => None,
        }
    } else {
        crate::credentials::read_api_key()?
    };
    if provider_kind(&ai.provider).is_none() {
        return Err("不支持的模型服务类型".into());
    }
    let url = reqwest::Url::parse(&ai.base_url).map_err(|_| "请输入有效的 API 地址")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("API 地址必须以 http:// 或 https:// 开头".into());
    }
    ai.timeout_seconds = ai.timeout_seconds.clamp(5, 30);
    let client = http_client(&ai)?;
    let response =
        request_builder_with_key(&client, &ai, reqwest::Method::GET, models_url(&ai), api_key)
            .send()
            .await
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?;
    let body = response
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;

    Ok(extract_model_ids(&ai.provider, &body)
        .into_iter()
        .map(|id| ModelInfo { id })
        .collect())
}
