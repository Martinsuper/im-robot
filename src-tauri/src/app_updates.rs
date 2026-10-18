//! Release discovery, version comparison and update asset downloads.
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use tauri::AppHandle;
use tauri::Manager;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateInfo {
    pub(crate) current_version: String,
    pub(crate) latest_version: String,
    pub(crate) available: bool,
    pub(crate) release_url: String,
}

pub(crate) fn version_parts(version: &str) -> Vec<u64> {
    version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .map(|part| part.parse().unwrap_or(0))
        .collect()
}

#[tauri::command]
pub(crate) async fn check_for_updates() -> Result<UpdateInfo, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let response = reqwest::Client::new()
        .get("https://api.github.com/repos/Martinsuper/im-robot/releases/latest")
        .header(reqwest::header::USER_AGENT, "Piko-Desktop-Companion")
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;
    let latest_version = response["tag_name"]
        .as_str()
        .ok_or_else(|| "发布源没有返回版本号".to_string())?
        .trim_start_matches('v')
        .to_string();
    let release_url = response["html_url"]
        .as_str()
        .unwrap_or("https://github.com/Martinsuper/im-robot/releases")
        .to_string();
    Ok(UpdateInfo {
        available: version_parts(&latest_version) > version_parts(&current_version),
        current_version,
        latest_version,
        release_url,
    })
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateStatus {
    pub(crate) current_version: String,
    pub(crate) latest_version: String,
    pub(crate) available: bool,
    pub(crate) release_url: String,
    pub(crate) release_notes: Option<String>,
    pub(crate) download_url: Option<String>,
    pub(crate) asset_name: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloadedUpdate {
    pub(crate) file_path: String,
    pub(crate) file_name: String,
    pub(crate) downloaded_bytes: u64,
}

#[tauri::command]
pub(crate) async fn check_for_updates_extended() -> Result<UpdateStatus, String> {
    let base = check_for_updates().await?;

    // Try to fetch more details from GitHub Releases
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get("https://api.github.com/repos/Martinsuper/im-robot/releases/latest")
        .header("User-Agent", "im-robot-update-checker")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Ok(UpdateStatus {
            current_version: base.current_version,
            latest_version: base.latest_version,
            available: base.available,
            release_url: base.release_url,
            release_notes: None,
            download_url: None,
            asset_name: None,
        });
    }

    let release: Value = response.json().await.map_err(|e| e.to_string())?;
    let latest = release["tag_name"]
        .as_str()
        .unwrap_or("unknown")
        .trim_start_matches('v')
        .to_string();
    let current = env!("CARGO_PKG_VERSION").to_string();

    let available = version_parts(&latest) > version_parts(&current);

    let release_notes = release["body"]
        .as_str()
        .map(|s| s.lines().take(10).collect::<Vec<_>>().join("\n"));

    let download_url = release["assets"].as_array().and_then(|assets| {
        assets
            .iter()
            .find(|asset| {
                let name = asset["name"].as_str().unwrap_or("");
                cfg!(target_os = "macos") && name.ends_with(".dmg")
                    || cfg!(target_os = "windows") && name.ends_with(".exe")
            })
            .and_then(|asset| asset["browser_download_url"].as_str())
            .map(String::from)
    });

    let asset_name = release["assets"].as_array().and_then(|assets| {
        assets
            .iter()
            .find(|asset| {
                let name = asset["name"].as_str().unwrap_or("");
                cfg!(target_os = "macos") && name.ends_with(".dmg")
                    || cfg!(target_os = "windows") && name.ends_with(".exe")
            })
            .and_then(|asset| asset["name"].as_str())
            .map(String::from)
    });

    Ok(UpdateStatus {
        current_version: current,
        latest_version: latest,
        available,
        release_url: release["html_url"]
            .as_str()
            .unwrap_or(&base.release_url)
            .to_string(),
        release_notes,
        download_url,
        asset_name,
    })
}

#[tauri::command]
pub(crate) async fn download_update_asset(
    app: AppHandle,
    download_url: String,
    asset_name: Option<String>,
) -> Result<DownloadedUpdate, String> {
    if download_url.trim().is_empty() {
        return Err("未提供可下载的更新地址".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(download_url.trim())
        .header("User-Agent", "im-robot-update-downloader")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;

    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let file_name = asset_name
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| "piko-update.bin".to_string());
    let cache_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let update_dir = cache_dir.join("updates");
    std::fs::create_dir_all(&update_dir).map_err(|e| e.to_string())?;
    let file_path = update_dir.join(&file_name);
    std::fs::write(&file_path, &bytes).map_err(|e| e.to_string())?;

    Ok(DownloadedUpdate {
        file_path: file_path.to_string_lossy().to_string(),
        file_name,
        downloaded_bytes: bytes.len() as u64,
    })
}
