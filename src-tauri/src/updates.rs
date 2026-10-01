//! 更新检查与安装包下载：GitHub Releases 查询、版本比较与受控下载。

use serde::Serialize;
use serde_json::Value;
use std::{fs, io::Write, path::Path, time::Duration};
use tauri::{AppHandle, Manager};
use thiserror::Error;

/// 模块内函数的类型化错误。Display 保留原有中文文案，经
/// `From<UpdateError> for String` 兼容命令边界既有的 `Result<_, String>` 签名。
#[derive(Debug, Error)]
pub enum UpdateError {
    #[error("未提供可下载的更新地址")]
    EmptyUrl,
    #[error("更新包必须通过 HTTPS 下载")]
    InsecureUrl,
    #[error("更新包文件名无效")]
    InvalidFileName,
    #[error("更新包缺少扩展名")]
    MissingExtension,
    #[error("不支持的更新包类型")]
    UnsupportedFileType,
    #[error("更新包过大，已取消下载")]
    TooLarge,
    #[error("请求失败：{0}")]
    Request(String),
    #[error("下载更新包失败：{0}")]
    Download(String),
    #[error("写入更新包失败：{0}")]
    Write(String),
    #[error("保存文件失败：{0}")]
    Io(String),
    #[error("发布源没有返回版本号")]
    MissingVersion,
}

impl From<UpdateError> for String {
    fn from(error: UpdateError) -> Self {
        error.to_string()
    }
}

#[tauri::command]
pub async fn download_update_asset(
    app: AppHandle,
    download_url: String,
    asset_name: Option<String>,
) -> Result<DownloadedUpdate, String> {
    let url = download_url.trim().to_string();
    if url.is_empty() {
        return Err(UpdateError::EmptyUrl.into());
    }
    if !url.to_ascii_lowercase().starts_with("https://") {
        return Err(UpdateError::InsecureUrl.into());
    }
    let file_name = sanitize_update_file_name(asset_name)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|error| UpdateError::Request(error.to_string()))?;

    let response = client
        .get(&url)
        .header("User-Agent", "im-robot-update-downloader")
        .send()
        .await
        .map_err(|error| UpdateError::Request(error.to_string()))?
        .error_for_status()
        .map_err(|error| UpdateError::Request(error.to_string()))?;

    if let Some(total) = response.content_length() {
        if total > MAX_UPDATE_ASSET_BYTES {
            return Err(UpdateError::TooLarge.into());
        }
    }

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| UpdateError::Io(error.to_string()))?;
    let update_dir = cache_dir.join("updates");
    fs::create_dir_all(&update_dir).map_err(|error| UpdateError::Io(error.to_string()))?;
    let file_path = update_dir.join(&file_name);

    let mut file =
        fs::File::create(&file_path).map_err(|error| UpdateError::Io(error.to_string()))?;
    let mut downloaded: u64 = 0;
    let mut response = response;
    loop {
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(error) => {
                drop(file);
                let _ = fs::remove_file(&file_path);
                return Err(UpdateError::Download(error.to_string()).into());
            }
        };
        downloaded += chunk.len() as u64;
        if downloaded > MAX_UPDATE_ASSET_BYTES {
            drop(file);
            let _ = fs::remove_file(&file_path);
            return Err(UpdateError::TooLarge.into());
        }
        if let Err(error) = file.write_all(&chunk) {
            let _ = fs::remove_file(&file_path);
            return Err(UpdateError::Write(error.to_string()).into());
        }
    }

    Ok(DownloadedUpdate {
        file_path: file_path.to_string_lossy().to_string(),
        file_name,
        downloaded_bytes: downloaded,
    })
}

const MAX_UPDATE_ASSET_BYTES: u64 = 512 * 1024 * 1024;

const UPDATE_ASSET_EXTENSIONS: [&str; 9] = [
    "exe", "msi", "dmg", "appimage", "deb", "rpm", "zip", "json", "sig",
];

/// Restrict the name to a bare file inside the updates directory: no absolute
/// paths, no traversal, and only installer-shaped extensions.
pub fn sanitize_update_file_name(raw: Option<String>) -> Result<String, UpdateError> {
    let candidate = raw.unwrap_or_else(|| "piko-update.bin".to_string());
    let trimmed = candidate.trim();
    let name = Path::new(trimmed)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
        .ok_or(UpdateError::InvalidFileName)?;
    // Unix 上反斜杠不是路径分隔符（file_name() 会原样保留），为让行为跨平台
    // 一致，名字里残留任何分隔符一律拒绝——合法的 GitHub 资产名不会包含它们。
    if name.contains('\\') || name.contains('/') {
        return Err(UpdateError::InvalidFileName);
    }
    let extension = name
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .ok_or(UpdateError::MissingExtension)?;
    if !UPDATE_ASSET_EXTENSIONS.contains(&extension.as_str()) {
        return Err(UpdateError::UnsupportedFileType);
    }
    Ok(name.to_string())
}

#[tauri::command]
pub async fn check_for_updates_extended() -> Result<UpdateStatus, String> {
    let base = check_for_updates().await?;

    // Try to fetch more details from GitHub Releases
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| UpdateError::Request(error.to_string()))?;

    let response = client
        .get("https://api.github.com/repos/Martinsuper/im-robot/releases/latest")
        .header("User-Agent", "im-robot-update-checker")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| UpdateError::Request(error.to_string()))?;

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

    let release: Value = response
        .json()
        .await
        .map_err(|error| UpdateError::Request(error.to_string()))?;
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    current_version: String,
    latest_version: String,
    available: bool,
    release_url: String,
    release_notes: Option<String>,
    download_url: Option<String>,
    asset_name: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedUpdate {
    file_path: String,
    file_name: String,
    downloaded_bytes: u64,
}

pub fn version_parts(version: &str) -> Vec<u64> {
    version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .map(|part| part.parse().unwrap_or(0))
        .collect()
}

#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateInfo, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let response = reqwest::Client::new()
        .get("https://api.github.com/repos/Martinsuper/im-robot/releases/latest")
        .header(reqwest::header::USER_AGENT, "Piko-Desktop-Companion")
        .send()
        .await
        .map_err(|error| UpdateError::Request(error.to_string()))?
        .error_for_status()
        .map_err(|error| UpdateError::Request(error.to_string()))?
        .json::<Value>()
        .await
        .map_err(|error| UpdateError::Request(error.to_string()))?;
    let latest_version = response["tag_name"]
        .as_str()
        .ok_or(UpdateError::MissingVersion)?
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
pub struct UpdateInfo {
    current_version: String,
    latest_version: String,
    available: bool,
    release_url: String,
}
