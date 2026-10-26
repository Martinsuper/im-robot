#[cfg(test)]
use std::io::Write;
// API credentials live in the OS credential store; legacy files migrate on first read.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

struct CredentialConfig {
    path: PathBuf,
    service: String,
}
static CONFIG: OnceLock<CredentialConfig> = OnceLock::new();
static CREDENTIAL_TRANSACTION: Mutex<()> = Mutex::new(());

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Credentials {
    api_key: Option<String>,
}

pub(crate) fn initialize(directory: PathBuf, service: &str) -> Result<(), String> {
    CONFIG
        .set(CredentialConfig {
            path: directory.join("api-credentials.json"),
            service: service.into(),
        })
        .map_err(|_| "密钥配置目录已初始化".to_string())
}

fn read_at(path: &Path) -> Result<Credentials, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "密钥配置文件格式错误".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Credentials::default()),
        Err(_) => Err("无法读取密钥配置文件".to_string()),
    }
}

#[cfg(test)]
fn update_at(path: &Path, input: Option<Option<String>>) -> Result<(), String> {
    let Some(input) = input else {
        return Ok(());
    };
    let api_key = input
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty());
    let directory = path.parent().ok_or("无法获取密钥配置目录")?;
    fs::create_dir_all(directory).map_err(|_| "无法创建密钥配置目录")?;
    // Unix temporary files use 0600. Atomic replacement retains this permission.
    let mut temp =
        tempfile::NamedTempFile::new_in(directory).map_err(|_| "无法创建密钥配置文件")?;
    serde_json::to_writer_pretty(&mut temp, &Credentials { api_key })
        .map_err(|_| "无法写入密钥配置文件")?;
    temp.flush().map_err(|_| "无法写入密钥配置文件")?;
    temp.as_file()
        .sync_all()
        .map_err(|_| "无法保存密钥配置文件")?;
    temp.persist(path).map_err(|_| "无法保存密钥配置文件")?;
    Ok(())
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(
        &CONFIG.get().ok_or("密钥配置目录尚未初始化")?.service,
        "model-api-key",
    )
    .map_err(|_| "无法访问系统凭据存储，请检查钥匙串或 Secret Service 是否可用".into())
}
fn storage_error() -> String {
    "无法读取或保存系统凭据，请解锁钥匙串或 Secret Service 后重试".into()
}

pub(crate) fn read_api_key() -> Result<Option<String>, String> {
    let _guard = CREDENTIAL_TRANSACTION.lock().map_err(|_| storage_error())?;
    let path = &CONFIG.get().ok_or("密钥配置目录尚未初始化")?.path;
    // Read the old file explicitly: corruption is actionable, never treated as a missing key.
    read_with_entry(path, &entry()?)
}

fn read_with_entry(path: &Path, entry: &keyring::Entry) -> Result<Option<String>, String> {
    let legacy = read_at(path)?;
    let current = match entry.get_password() {
        Ok(value) => Some(value),
        Err(keyring::Error::NoEntry) => None,
        Err(_) => return Err(storage_error()),
    };
    let key = match (current, legacy.api_key) {
        (Some(key), Some(legacy)) if key != legacy => {
            return Err("系统凭据与旧密钥不一致，原文件已保留；请在设置中重新保存密钥".into());
        }
        (Some(key), _) => Some(key),
        (None, Some(key)) => {
            entry.set_password(&key).map_err(|_| storage_error())?;
            if entry.get_password().map_err(|_| storage_error())? != key {
                return Err("密钥迁移验证失败，原文件已保留".into());
            }
            Some(key)
        }
        (None, None) => None,
    };
    if path.exists() {
        fs::remove_file(path)
            .map_err(|_| "密钥已存入系统凭据，但无法删除旧密钥文件".to_string())?;
    }
    Ok(key.filter(|key| !key.trim().is_empty()))
}

pub(crate) fn update_api_key(input: Option<Option<String>>) -> Result<(), String> {
    let _guard = CREDENTIAL_TRANSACTION.lock().map_err(|_| storage_error())?;
    let Some(input) = input else {
        return Ok(());
    };
    let path = &CONFIG.get().ok_or("密钥配置目录尚未初始化")?.path;
    let entry = entry()?;
    match input.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()) {
        Some(key) => entry.set_password(&key).map_err(|_| storage_error())?,
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => (),
            Err(_) => return Err(storage_error()),
        },
    }
    if path.exists() {
        fs::remove_file(path).map_err(|_| "无法删除旧密钥文件".to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persists_preserves_and_clears_key() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("api-credentials.json");
        assert!(read_at(&path).unwrap().api_key.is_none());
        update_at(&path, Some(Some("  test-not-a-secret  ".into()))).unwrap();
        assert_eq!(
            read_at(&path).unwrap().api_key.as_deref(),
            Some("test-not-a-secret")
        );
        update_at(&path, None).unwrap();
        assert_eq!(
            read_at(&path).unwrap().api_key.as_deref(),
            Some("test-not-a-secret")
        );
        update_at(&path, Some(None)).unwrap();
        assert!(read_at(&path).unwrap().api_key.is_none());
        update_at(&path, Some(Some("   ".into()))).unwrap();
        assert!(read_at(&path).unwrap().api_key.is_none());
    }
    #[test]
    fn malformed_file_does_not_expose_contents() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("api-credentials.json");
        fs::write(&path, "secret-content").unwrap();
        assert_eq!(
            read_at(&path).err().as_deref(),
            Some("密钥配置文件格式错误")
        );
    }
    #[test]
    #[cfg(unix)]
    fn replacement_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("api-credentials.json");
        fs::write(&path, "{}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        update_at(&path, Some(Some("test-not-a-secret".into()))).unwrap();
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[cfg(test)]
mod migration_tests {
    use super::*;
    fn mock_entry() -> keyring::Entry {
        keyring::Entry::new_with_credential(
            keyring::mock::default_credential_builder()
                .build(None, "piko-tests", "key")
                .unwrap(),
        )
    }
    #[test]
    fn migrates_and_verifies_before_removing_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("api-credentials.json");
        update_at(&path, Some(Some("legacy-secret".into()))).unwrap();
        let entry = mock_entry();
        assert_eq!(
            read_with_entry(&path, &entry).unwrap().as_deref(),
            Some("legacy-secret")
        );
        assert!(!path.exists());
        assert_eq!(entry.get_password().unwrap(), "legacy-secret");
        assert_eq!(
            read_with_entry(&path, &entry).unwrap().as_deref(),
            Some("legacy-secret")
        );
    }
    #[test]
    fn conflicting_credentials_never_silently_discard_the_legacy_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("api-credentials.json");
        update_at(&path, Some(Some("new-legacy-key".into()))).unwrap();
        let entry = mock_entry();
        entry.set_password("existing-system-key").unwrap();
        assert!(read_with_entry(&path, &entry).is_err());
        assert_eq!(
            read_at(&path).unwrap().api_key.as_deref(),
            Some("new-legacy-key")
        );
        assert_eq!(entry.get_password().unwrap(), "existing-system-key");
    }
    #[test]
    fn credential_store_errors_preserve_legacy_file_and_are_visible() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("api-credentials.json");
        update_at(&path, Some(Some("legacy-secret".into()))).unwrap();
        let entry = mock_entry();
        entry
            .get_credential()
            .downcast_ref::<keyring::mock::MockCredential>()
            .unwrap()
            .set_error(keyring::Error::Invalid("locked".into(), "locked".into()));
        let error = read_with_entry(&path, &entry).unwrap_err();
        assert!(!error.contains("legacy-secret"));
        assert!(path.exists());
    }
}

fn mimo_tts_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(
        &CONFIG.get().ok_or("密钥配置目录尚未初始化")?.service,
        "mimo-tts-api-key",
    )
    .map_err(|_| storage_error())
}
pub(crate) fn read_mimo_tts_key() -> Result<Option<String>, String> {
    match mimo_tts_entry()?.get_password() {
        Ok(key) => Ok(Some(key).filter(|s| !s.trim().is_empty())),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(storage_error()),
    }
}
pub(crate) fn update_mimo_tts_key(key: Option<String>) -> Result<(), String> {
    let Some(key) = key else {
        return Ok(());
    };
    if key.trim().is_empty() {
        match mimo_tts_entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(storage_error()),
        }
    } else {
        mimo_tts_entry()?
            .set_password(key.trim())
            .map_err(|_| storage_error())
    }
}
