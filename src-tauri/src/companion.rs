//! Provider-backed companion response generation.
use crate::chat::parse_pet_companion_generation_output;
use crate::chat::pet_companion_generation_system_prompt;
use crate::chat::pet_companion_generation_user_prompt;
use crate::providers::http_client;
use crate::providers::pet_companion_generation_url;
use crate::providers::provider_kind;
use crate::providers::request_builder;
use crate::providers::validate_ai_settings;
use crate::providers::ProviderKind;
use crate::settings::read_settings;
use serde::Deserialize;
use serde::Serialize;
use serde_json::json;
use serde_json::Value;
use tauri::AppHandle;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PetPersonalityInput {
    pub(crate) energy: f32,
    pub(crate) humor: f32,
    pub(crate) curiosity: f32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PetCompanionGenerationInput {
    pub(crate) mode: String,
    pub(crate) scene: String,
    pub(crate) bond_tier: String,
    pub(crate) interaction_type: Option<String>,
    pub(crate) personality: PetPersonalityInput,
    pub(crate) personality_summary: Option<String>,
    pub(crate) context: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PetCompanionGenerationOutput {
    pub(crate) message: Option<String>,
    pub(crate) motion_style: Option<String>,
    pub(crate) behavior_profile: Option<String>,
    pub(crate) behavior_priority: Option<Vec<String>>,
}

#[tauri::command]
pub(crate) async fn generate_pet_companion_response(
    app: AppHandle,
    input: PetCompanionGenerationInput,
) -> Result<PetCompanionGenerationOutput, String> {
    let settings = read_settings(&app);
    validate_ai_settings(&settings.ai)?;

    let client = http_client(&settings.ai)?;
    let prompt = pet_companion_generation_user_prompt(&input);
    let request_body = match provider_kind(&settings.ai.provider) {
        Some(ProviderKind::OpenAiCompatible) => json!({
            "model": settings.ai.model,
            "messages": [
                { "role": "system", "content": pet_companion_generation_system_prompt(&settings.companion_name) },
                { "role": "user", "content": prompt },
            ],
            "temperature": settings.ai.temperature,
            "stream": false,
            "max_tokens": 256
        }),
        Some(ProviderKind::Anthropic) => json!({
            "model": settings.ai.model,
            "system": pet_companion_generation_system_prompt(&settings.companion_name),
            "messages": [
                { "role": "user", "content": prompt },
            ],
            "temperature": settings.ai.temperature,
            "max_tokens": 256
        }),
        Some(ProviderKind::Gemini) => json!({
            "systemInstruction": { "parts": [{ "text": pet_companion_generation_system_prompt(&settings.companion_name) }] },
            "contents": [
                { "role": "user", "parts": [{ "text": prompt }] }
            ],
            "generationConfig": { "temperature": settings.ai.temperature, "maxOutputTokens": 256 }
        }),
        None => return Err("不支持的模型服务类型".to_string()),
    };

    let response = request_builder(
        &client,
        &settings.ai,
        reqwest::Method::POST,
        pet_companion_generation_url(&settings.ai)?,
    )
    .json(&request_body)
    .send()
    .await
    .map_err(|error| error.to_string())?
    .error_for_status()
    .map_err(|error| error.to_string())?;

    let body = response
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;
    parse_pet_companion_generation_output(&settings.ai.provider, &body)
}
