//! Trusted release discovery and bounded, verified, cancellable asset downloads.
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::{LazyLock, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

const REPOSITORY: &str = "Martinsuper/im-robot";
const RELEASE_API: &str = "https://api.github.com/repos/Martinsuper/im-robot/releases/latest";
const MAX_DOWNLOAD_BYTES: u64 = 1024 * 1024 * 1024;
static ACTIVE_DOWNLOAD: LazyLock<Mutex<Option<(String, CancellationToken)>>> =
    LazyLock::new(|| Mutex::new(None));

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateInfo {
    pub(crate) current_version: String,
    pub(crate) latest_version: String,
    pub(crate) available: bool,
    pub(crate) release_url: String,
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
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress<'a> {
    download_id: &'a str,
    received: u64,
    total: Option<u64>,
}

pub(crate) fn version_parts(version: &str) -> Vec<u64> {
    let mut parts: Vec<_> = version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .map(|part| part.parse().unwrap_or(0))
        .collect();
    while parts.last() == Some(&0) {
        parts.pop();
    }
    parts
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("Piko-update-checker")
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let url = attempt.url();
            let trusted = matches!(
                url.host_str(),
                Some(
                    "github.com"
                        | "release-assets.githubusercontent.com"
                        | "objects.githubusercontent.com"
                )
            );
            if attempt.previous().len() >= 5 || url.scheme() != "https" || !trusted {
                attempt.error("更新下载重定向地址不受信任")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| e.to_string())
}
async fn latest_release(client: &reqwest::Client) -> Result<Value, String> {
    let response = client
        .get(RELEASE_API)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    // Release metadata must also be bounded.
    let bytes = bounded_body(response, 2 * 1024 * 1024).await?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
async fn bounded_body(response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            return Err("更新响应超过大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
fn valid_filename(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', ':'])
        && !name.chars().any(char::is_control)
        && Path::new(name).file_name().and_then(|n| n.to_str()) == Some(name)
}
fn trusted_asset_url(url: &str, name: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(url) else {
        return false;
    };
    valid_filename(name)
        && url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url
            .path()
            .starts_with(&format!("/{REPOSITORY}/releases/download/"))
        && url.path_segments().and_then(|mut parts| parts.next_back()) == Some(name)
}
fn matches_platform(name: &str, os: &str, arch: &str) -> bool {
    if !valid_filename(name) {
        return false;
    }
    let name = name.to_ascii_lowercase();
    let architecture = match arch {
        "aarch64" => name.contains("aarch64") || name.contains("arm64"),
        "x86_64" => name.contains("x86_64") || name.contains("x64") || name.contains("amd64"),
        _ => false,
    };
    (architecture || (os == "macos" && name.contains("universal")))
        && match os {
            "macos" => name.ends_with(".dmg"),
            "windows" => name.ends_with(".exe"),
            "linux" => name.ends_with(".appimage"),
            _ => false,
        }
}
fn status(release: &Value, os: &str, arch: &str) -> Result<UpdateStatus, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let latest_version = release["tag_name"]
        .as_str()
        .ok_or("发布源没有返回版本号")?
        .trim_start_matches('v')
        .to_string();
    let asset = release["assets"].as_array().and_then(|assets| {
        assets.iter().find(|asset| {
            let name = asset["name"].as_str().unwrap_or_default();
            matches_platform(name, os, arch)
                && trusted_asset_url(
                    asset["browser_download_url"].as_str().unwrap_or_default(),
                    name,
                )
        })
    });
    Ok(UpdateStatus {
        available: version_parts(&latest_version) > version_parts(&current_version),
        current_version,
        latest_version,
        release_url: format!("https://github.com/{REPOSITORY}/releases/latest"),
        release_notes: release["body"]
            .as_str()
            .map(|s| s.lines().take(10).collect::<Vec<_>>().join("\n")),
        download_url: asset
            .and_then(|a| a["browser_download_url"].as_str())
            .map(String::from),
        asset_name: asset.and_then(|a| a["name"].as_str()).map(String::from),
    })
}
#[tauri::command]
pub(crate) async fn check_for_updates() -> Result<UpdateInfo, String> {
    let status = check_for_updates_extended().await?;
    Ok(UpdateInfo {
        current_version: status.current_version,
        latest_version: status.latest_version,
        available: status.available,
        release_url: status.release_url,
    })
}
#[tauri::command]
pub(crate) async fn check_for_updates_extended() -> Result<UpdateStatus, String> {
    status(
        &latest_release(&client()?).await?,
        std::env::consts::OS,
        std::env::consts::ARCH,
    )
}
fn checksum(input: &str) -> Result<String, String> {
    let digest = input
        .strip_prefix("sha256:")
        .unwrap_or(input)
        .split_whitespace()
        .next()
        .unwrap_or_default();
    if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("发布源没有提供有效 SHA-256 校验值".into());
    }
    Ok(digest.to_ascii_lowercase())
}
async fn expected_digest(
    client: &reqwest::Client,
    release: &Value,
    url: &str,
    name: &str,
) -> Result<String, String> {
    let assets = release["assets"].as_array().ok_or("发布源没有安装包")?;
    let asset = assets
        .iter()
        .find(|asset| {
            asset["name"].as_str() == Some(name)
                && asset["browser_download_url"].as_str() == Some(url)
        })
        .ok_or("安装包不属于当前正式发布，请重新检查更新")?;
    if let Some(digest) = asset["digest"].as_str() {
        return checksum(digest);
    }
    let checksum_name = format!("{name}.sha256");
    let checksum_url = assets
        .iter()
        .find(|a| a["name"].as_str() == Some(&checksum_name))
        .and_then(|a| a["browser_download_url"].as_str())
        .ok_or("发布源缺少安装包校验值，已停止下载")?;
    if !trusted_asset_url(checksum_url, &checksum_name) {
        return Err("校验文件地址不受信任".into());
    }
    let response = client
        .get(checksum_url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let bytes = bounded_body(response, 1024).await?;
    checksum(std::str::from_utf8(&bytes).map_err(|_| "校验文件格式错误")?)
}
struct DownloadGuard;
impl Drop for DownloadGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE_DOWNLOAD.lock() {
            *active = None;
        }
    }
}
#[tauri::command]
pub(crate) fn cancel_update_download(download_id: String) -> Result<(), String> {
    let active = ACTIVE_DOWNLOAD.lock().map_err(|e| e.to_string())?;
    if let Some((id, token)) = active.as_ref() {
        if *id == download_id {
            token.cancel();
        }
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn download_update_asset(
    app: AppHandle,
    download_url: String,
    asset_name: Option<String>,
    download_id: String,
) -> Result<DownloadedUpdate, String> {
    let name = asset_name.ok_or("未提供安装包文件名")?;
    if !trusted_asset_url(&download_url, &name)
        || !matches_platform(&name, std::env::consts::OS, std::env::consts::ARCH)
    {
        return Err("安装包地址、文件名或平台不受支持".into());
    }
    if download_id.is_empty() || download_id.len() > 100 {
        return Err("下载标识无效".into());
    }
    let token = CancellationToken::new();
    {
        let mut active = ACTIVE_DOWNLOAD.lock().map_err(|e| e.to_string())?;
        if active.is_some() {
            return Err("已有更新正在下载".into());
        }
        *active = Some((download_id.clone(), token.clone()));
    }
    let _guard = DownloadGuard;
    tokio::select! { biased;
        _ = token.cancelled() => Err("更新下载已取消".into()),
        result = download_verified(&app, &download_url, &name, &download_id) => result,
    }
}
async fn download_verified(
    app: &AppHandle,
    url: &str,
    name: &str,
    id: &str,
) -> Result<DownloadedUpdate, String> {
    let client = client()?;
    let expected = expected_digest(&client, &latest_release(&client).await?, url, name).await?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("updates");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|e| e.to_string())?;
    let (temporary, received) = receive_verified(
        response,
        &directory,
        &expected,
        MAX_DOWNLOAD_BYTES,
        |received, total| {
            let _ = app.emit(
                "update-download-progress",
                DownloadProgress {
                    download_id: id,
                    received,
                    total,
                },
            );
        },
    )
    .await?;
    #[cfg(unix)]
    if name.to_ascii_lowercase().ends_with(".appimage") {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let destination = directory.join(name);
    temporary.persist(&destination).map_err(|e| e.to_string())?;
    let _ = app.emit(
        "update-download-progress",
        DownloadProgress {
            download_id: id,
            received,
            total: Some(received),
        },
    );
    Ok(DownloadedUpdate {
        file_path: destination.to_string_lossy().into_owned(),
        file_name: name.into(),
        downloaded_bytes: received,
    })
}

async fn receive_verified(
    response: reqwest::Response,
    directory: &Path,
    expected: &str,
    limit: u64,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<(tempfile::NamedTempFile, u64), String> {
    let total = response.content_length();
    if total.is_some_and(|size| size > limit) {
        return Err("安装包超过大小限制".into());
    }
    let temporary = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    let mut file = tokio::fs::File::from_std(temporary.reopen().map_err(|e| e.to_string())?);
    let mut received = 0u64;
    let mut digest = Sha256::new();
    let mut stream = response.bytes_stream();
    let mut last_progress = std::time::Instant::now();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        if received > limit {
            return Err("安装包超过 1 GiB 限制".into());
        }
        digest.update(&chunk);
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        if last_progress.elapsed() >= Duration::from_millis(200) {
            progress(received, total);
            last_progress = std::time::Instant::now();
        }
    }
    if received == 0
        || total.is_some_and(|size| size != received)
        || format!("{:x}", digest.finalize()) != expected
    {
        return Err("安装包完整性校验失败，已丢弃下载文件".into());
    }
    file.flush().await.map_err(|e| e.to_string())?;
    file.sync_all().await.map_err(|e| e.to_string())?;
    drop(file);
    Ok((temporary, received))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_path_traversal_and_untrusted_origins() {
        for name in [
            "../evil.dmg",
            "/tmp/evil.dmg",
            "C:\\evil.exe",
            "a/b",
            "..",
            "a\nb",
        ] {
            assert!(!valid_filename(name));
        }
        assert!(trusted_asset_url(
            "https://github.com/Martinsuper/im-robot/releases/download/v1/Piko_aarch64.dmg",
            "Piko_aarch64.dmg"
        ));
        for url in [
            "http://github.com/Martinsuper/im-robot/releases/download/v1/Piko.dmg",
            "https://evil.com/Piko.dmg",
            "https://github.com/other/repo/releases/download/v1/Piko.dmg",
        ] {
            assert!(!trusted_asset_url(url, "Piko.dmg"));
        }
    }
    #[test]
    fn selects_architecture_and_linux_without_guessing() {
        let release = serde_json::json!({"tag_name":"v9.0.0", "assets": [
            {"name":"Piko_x64.dmg","browser_download_url":"https://github.com/Martinsuper/im-robot/releases/download/v9/Piko_x64.dmg"},
            {"name":"Piko_aarch64.dmg","browser_download_url":"https://github.com/Martinsuper/im-robot/releases/download/v9/Piko_aarch64.dmg"},
            {"name":"Piko_amd64.AppImage","browser_download_url":"https://github.com/Martinsuper/im-robot/releases/download/v9/Piko_amd64.AppImage"}
        ]});
        assert_eq!(
            status(&release, "macos", "aarch64")
                .unwrap()
                .asset_name
                .as_deref(),
            Some("Piko_aarch64.dmg")
        );
        assert_eq!(
            status(&release, "linux", "x86_64")
                .unwrap()
                .asset_name
                .as_deref(),
            Some("Piko_amd64.AppImage")
        );
        assert!(status(&release, "windows", "aarch64")
            .unwrap()
            .download_url
            .is_none());
        assert_eq!(version_parts("1.2"), version_parts("1.2.0"));
    }
    #[test]
    fn checksum_requires_exact_sha256() {
        assert!(checksum("md5:abc").is_err());
        assert!(checksum(&"g".repeat(64)).is_err());
        assert_eq!(
            checksum(&format!("sha256:{}", "A".repeat(64))).unwrap(),
            "a".repeat(64)
        );
    }
}

#[cfg(test)]
mod download_tests {
    use super::*;
    use std::io::{Read, Write};
    async fn response(body: &'static [u8]) -> reqwest::Response {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let _ = socket.read(&mut request);
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            let _ = socket.write_all(body);
        });
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap()
    }
    #[tokio::test]
    async fn only_verified_downloads_survive_and_limits_clean_up() {
        let directory = tempfile::tempdir().unwrap();
        let hash = format!("{:x}", Sha256::digest(b"installer"));
        let (file, bytes) = receive_verified(
            response(b"installer").await,
            directory.path(),
            &hash,
            100,
            |_, _| {},
        )
        .await
        .unwrap();
        assert_eq!(bytes, 9);
        assert_eq!(std::fs::read(file.path()).unwrap(), b"installer");
        drop(file);
        assert!(receive_verified(
            response(b"tampered").await,
            directory.path(),
            &hash,
            100,
            |_, _| {}
        )
        .await
        .is_err());
        assert!(receive_verified(
            response(b"installer").await,
            directory.path(),
            &hash,
            2,
            |_, _| {}
        )
        .await
        .is_err());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }
}
