//! Local credentials are separate from settings and excluded from exports/snapshots.
//! Atomic replacement keeps Unix permissions at 0600. Runtime never accesses Keychain.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

static CONFIG: OnceLock<PathBuf> = OnceLock::new();
static CREDENTIAL_TRANSACTION: Mutex<()> = Mutex::new(());

#[derive(Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct Credentials {
    api_key: Option<String>,
    mimo_tts_api_key: Option<String>,
    embedding_api_key: Option<String>,
}

#[derive(Clone, Copy)]
enum Key {
    Model,
    Speech,
    Embedding,
}

impl Credentials {
    fn key(&mut self, key: Key) -> &mut Option<String> {
        match key {
            Key::Model => &mut self.api_key,
            Key::Speech => &mut self.mimo_tts_api_key,
            Key::Embedding => &mut self.embedding_api_key,
        }
    }
}

pub(crate) fn initialize(directory: PathBuf) -> Result<(), String> {
    CONFIG
        .set(directory.join("api-credentials.json"))
        .map_err(|_| "密钥配置目录已初始化".to_string())
}

fn storage_error() -> String {
    "无法读取或保存本机密钥文件，请检查应用数据目录的访问权限".into()
}

fn read_at(path: &Path) -> Result<Credentials, String> {
    match fs::read(path) {
        Ok(bytes) => {
            let credentials =
                serde_json::from_slice(&bytes).map_err(|_| "密钥配置文件格式错误".to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                    .map_err(|_| storage_error())?;
            }
            Ok(credentials)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Credentials::default()),
        Err(_) => Err(storage_error()),
    }
}

fn update_at(path: &Path, key: Key, input: Option<Option<String>>) -> Result<(), String> {
    let Some(input) = input else {
        return Ok(());
    };
    let mut credentials = read_at(path)?;
    *credentials.key(key) = input
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let directory = path.parent().ok_or_else(storage_error)?;
    fs::create_dir_all(directory).map_err(|_| storage_error())?;
    let mut temp = tempfile::NamedTempFile::new_in(directory).map_err(|_| storage_error())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| storage_error())?;
    }
    serde_json::to_writer_pretty(&mut temp, &credentials).map_err(|_| storage_error())?;
    temp.flush().map_err(|_| storage_error())?;
    temp.as_file().sync_all().map_err(|_| storage_error())?;
    temp.persist(path).map_err(|_| storage_error())?;
    Ok(())
}

fn read_key(key: Key) -> Result<Option<String>, String> {
    let _guard = CREDENTIAL_TRANSACTION.lock().map_err(|_| storage_error())?;
    let path = CONFIG.get().ok_or("密钥配置目录尚未初始化")?;
    Ok(read_at(path)?
        .key(key)
        .take()
        .filter(|value| !value.trim().is_empty()))
}

fn update_key(key: Key, input: Option<Option<String>>) -> Result<(), String> {
    let _guard = CREDENTIAL_TRANSACTION.lock().map_err(|_| storage_error())?;
    update_at(CONFIG.get().ok_or("密钥配置目录尚未初始化")?, key, input)
}

pub(crate) fn read_api_key() -> Result<Option<String>, String> {
    read_key(Key::Model)
}
pub(crate) fn update_api_key(input: Option<Option<String>>) -> Result<(), String> {
    update_key(Key::Model, input)
}
pub(crate) fn read_mimo_tts_key() -> Result<Option<String>, String> {
    read_key(Key::Speech)
}
pub(crate) fn update_mimo_tts_key(input: Option<String>) -> Result<(), String> {
    update_key(Key::Speech, input.map(Some))
}
pub(crate) fn read_embedding_key() -> Result<Option<String>, String> {
    read_key(Key::Embedding)
}
pub(crate) fn update_embedding_key(input: Option<String>) -> Result<(), String> {
    update_key(Key::Embedding, input.map(Some))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_preserves_and_clears_independent_keys() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("api-credentials.json");
        assert!(read_at(&path).unwrap().api_key.is_none());
        update_at(&path, Key::Model, Some(Some("  model-test  ".into()))).unwrap();
        update_at(&path, Key::Speech, Some(Some("speech-test".into()))).unwrap();
        update_at(&path, Key::Embedding, Some(Some("embedding-test".into()))).unwrap();
        update_at(&path, Key::Model, None).unwrap();
        let saved = read_at(&path).unwrap();
        assert_eq!(saved.api_key.as_deref(), Some("model-test"));
        assert_eq!(saved.mimo_tts_api_key.as_deref(), Some("speech-test"));
        assert_eq!(saved.embedding_api_key.as_deref(), Some("embedding-test"));
        update_at(&path, Key::Speech, Some(Some("   ".into()))).unwrap();
        update_at(&path, Key::Embedding, Some(None)).unwrap();
        let saved = read_at(&path).unwrap();
        assert!(saved.mimo_tts_api_key.is_none());
        assert!(saved.embedding_api_key.is_none());
        assert_eq!(saved.api_key.as_deref(), Some("model-test"));
        update_at(&path, Key::Model, Some(None)).unwrap();
        assert!(read_at(&path).unwrap().api_key.is_none());
    }

    #[test]
    fn legacy_model_file_is_preserved_when_adding_other_keys() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("api-credentials.json");
        fs::write(&path, r#"{"apiKey":"legacy-test"}"#).unwrap();
        update_at(&path, Key::Speech, Some(Some("speech-test".into()))).unwrap();
        assert_eq!(
            read_at(&path).unwrap().api_key.as_deref(),
            Some("legacy-test")
        );
    }

    #[test]
    fn corrupt_file_is_not_overwritten_and_errors_do_not_expose_contents() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("api-credentials.json");
        fs::write(&path, "private-test-content").unwrap();
        assert_eq!(
            read_at(&path).err().as_deref(),
            Some("密钥配置文件格式错误")
        );
        let error = update_at(&path, Key::Model, Some(Some("replacement".into()))).unwrap_err();
        assert!(!error.contains("private-test-content"));
        assert_eq!(fs::read_to_string(path).unwrap(), "private-test-content");
    }

    #[test]
    #[cfg(unix)]
    fn existing_and_replaced_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("api-credentials.json");
        fs::write(&path, "{}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        read_at(&path).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        update_at(&path, Key::Model, Some(Some("test-key".into()))).unwrap();
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
