//! API credentials are separate from settings and exported application data.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::OnceLock,
};

static CONFIG_PATH: OnceLock<PathBuf> = OnceLock::new();

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Credentials {
    api_key: Option<String>,
}

pub(crate) fn initialize(directory: PathBuf) -> Result<(), String> {
    CONFIG_PATH
        .set(directory.join("api-credentials.json"))
        .map_err(|_| "密钥配置目录已初始化".to_string())
}

fn read_at(path: &Path) -> Result<Credentials, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "密钥配置文件格式错误".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Credentials::default()),
        Err(_) => Err("无法读取密钥配置文件".to_string()),
    }
}

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

pub(crate) fn read_api_key() -> Option<String> {
    read_at(CONFIG_PATH.get()?)
        .ok()?
        .api_key
        .filter(|key| !key.trim().is_empty())
}

pub(crate) fn update_api_key(input: Option<Option<String>>) -> Result<(), String> {
    update_at(CONFIG_PATH.get().ok_or("密钥配置目录尚未初始化")?, input)
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
