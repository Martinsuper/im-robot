//! Versioned, consistent local snapshots. Credentials, caches and executable plugins are excluded.
use crate::memory::MemoryDb;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
const VERSION: u32 = 1;
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_FILES: usize = 20_000;
const CONFIG_FILES: &[&str] = &[
    "app-settings.json",
    "reminders.json",
    "calendar-events.json",
    "schedule-items.json",
    "schedule-migration.json",
    "memos.json",
    "html-favorites.json",
    "chat-history.json",
    "chat-sessions.json",
    "chat-sessions.conversation-links-v1.json",
    "chat-migration.json",
    "focus-records.json",
    "typing-stats.json",
    "pet-state.json",
    "calendar-sync-mapping.json",
    "calendar-sync-deleted-local-ids.json",
    "pet-position.json",
    "bubble-size.json",
];
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileEntry {
    pub root: String,
    pub path: String,
    pub owner: String,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Manifest {
    pub schema_version: u32,
    pub app_version: String,
    pub id: String,
    pub created_at: u64,
    pub files: Vec<FileEntry>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotInfo {
    pub id: String,
    pub directory: String,
    pub created_at: u64,
    pub file_count: usize,
    pub bytes: u64,
    pub excluded: Vec<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestoreResult {
    pub rollback: SnapshotInfo,
    pub restored_files: usize,
    pub restart_required: bool,
}
#[derive(Clone)]
struct Roots {
    config: PathBuf,
    data: PathBuf,
}
#[derive(Deserialize, Serialize)]
struct Recovery {
    rollback_id: String,
    #[serde(default)]
    restore_id: Option<String>,
    #[serde(default)]
    applying: bool,
}
fn roots(app: &AppHandle) -> Result<Roots, String> {
    let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    for directory in [&config, &data] {
        fs::create_dir_all(directory).map_err(error)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).map_err(error)?;
        }
    }
    Ok(Roots {
        config: config.canonicalize().map_err(error)?,
        data: data.canonicalize().map_err(error)?,
    })
}

fn error(e: impl std::fmt::Display) -> String {
    format!("数据快照操作失败：{e}")
}
fn valid_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && Path::new(path)
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(_)))
}
fn valid_entry(entry: &FileEntry) -> bool {
    valid_relative(&entry.path)
        && match entry.root.as_str() {
            "config" => CONFIG_FILES.contains(&entry.path.as_str()),
            "sqlite" => entry.path == "memory.db",
            "data" => {
                let parts: Vec<_> = entry.path.split('/').collect();
                parts.first() == Some(&"agent")
                    && parts.len() >= 2
                    && !matches!(parts[1], "workspace" | "diagnostics")
            }
            _ => false,
        }
}
fn source(roots: &Roots, entry: &FileEntry) -> PathBuf {
    if entry.root == "data" {
        roots.data.join(&entry.path)
    } else {
        roots.config.join(&entry.path)
    }
}
fn stored(directory: &Path, entry: &FileEntry) -> PathBuf {
    directory.join(&entry.root).join(&entry.path)
}
fn ensure_no_symlinks(path: &Path) -> Result<(), String> {
    for part in path.ancestors() {
        match fs::symlink_metadata(part) {
            Ok(meta) if meta.file_type().is_symlink() => {
                if part.parent() == Some(Path::new("/")) {
                    continue;
                }
                return Err("快照不允许符号链接".into());
            }
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(error(e)),
        }
    }
    Ok(())
}
fn digest(path: &Path) -> Result<(u64, String), String> {
    let mut file = fs::File::open(path).map_err(error)?;
    let mut hash = Sha256::new();
    let mut size = 0;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if crate::background::SUPERVISOR.token().is_cancelled() {
            return Err("应用正在退出，已停止数据任务".into());
        }
        let count = file.read(&mut buffer).map_err(error)?;
        if count == 0 {
            break;
        }
        size += count as u64;
        if size > MAX_BYTES {
            return Err("备份文件超过大小限制".into());
        }
        hash.update(&buffer[..count]);
    }
    Ok((size, format!("{:x}", hash.finalize())))
}
fn atomic_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("快照路径无效")?;
    fs::create_dir_all(parent).map_err(error)?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(error)?;
    file.write_all(bytes).map_err(error)?;
    file.as_file().sync_all().map_err(error)?;
    file.persist(path).map_err(error)?;
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|dir| dir.sync_all())
        .map_err(error)?;
    Ok(())
}
fn copy_atomic(from: &Path, to: &Path) -> Result<(), String> {
    ensure_no_symlinks(to)?;
    let parent = to.parent().ok_or("快照路径无效")?;
    fs::create_dir_all(parent).map_err(error)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(error)?;
    std::io::copy(&mut fs::File::open(from).map_err(error)?, &mut temporary).map_err(error)?;
    temporary.as_file().sync_all().map_err(error)?;
    temporary.persist(to).map_err(error)?;
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|dir| dir.sync_all())
        .map_err(error)?;
    Ok(())
}
fn owner(name: &str) -> &str {
    match name {
        "pet-state.json" => "pet",
        "app-settings.json" => "settings",
        "memory.db" => "memory",
        "chat-history.json"
        | "chat-sessions.json"
        | "chat-migration.json"
        | "chat-sessions.conversation-links-v1.json" => "chat",
        "memos.json" => "memos",
        "html-favorites.json" => "favorites",
        "focus-records.json" | "typing-stats.json" => "activity",
        _ => "desktop-and-schedule",
    }
}
fn agent_files(root: &Path, directory: &Path, out: &mut Vec<FileEntry>) -> Result<(), String> {
    if !directory.exists() {
        return Ok(());
    }
    ensure_no_symlinks(directory)?;
    for entry in fs::read_dir(directory).map_err(error)? {
        let entry = entry.map_err(error)?;
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(error)?
            .to_string_lossy()
            .replace('\\', "/");
        let item = FileEntry {
            root: "data".into(),
            path: relative,
            owner: "agent".into(),
            bytes: 0,
            sha256: String::new(),
        };
        if !valid_entry(&item) {
            continue;
        }
        ensure_no_symlinks(&path)?;
        if entry.file_type().map_err(error)?.is_dir() {
            agent_files(root, &path, out)?;
        } else if entry.file_type().map_err(error)?.is_file() {
            out.push(item);
            if out.len() > MAX_FILES {
                return Err("备份文件数量超过限制".into());
            }
        }
    }
    Ok(())
}
fn inventory(roots: &Roots) -> Result<Vec<FileEntry>, String> {
    let mut items = Vec::new();
    for name in CONFIG_FILES {
        let path = roots.config.join(name);
        if path.exists() {
            ensure_no_symlinks(&path)?;
            items.push(FileEntry {
                root: "config".into(),
                path: (*name).into(),
                owner: owner(name).into(),
                bytes: 0,
                sha256: String::new(),
            });
        }
    }
    agent_files(&roots.data, &roots.data.join("agent"), &mut items)?;
    Ok(items)
}
fn info(directory: &Path, manifest: &Manifest) -> SnapshotInfo {
    SnapshotInfo {
        id: manifest.id.clone(),
        directory: directory.to_string_lossy().into_owned(),
        created_at: manifest.created_at,
        file_count: manifest.files.len(),
        bytes: manifest.files.iter().map(|f| f.bytes).sum(),
        excluded: vec![
            "系统凭据/API Key".into(),
            "下载缓存、语音模型与插件程序".into(),
            "工作目录原始文件与诊断日志".into(),
        ],
    }
}
fn capture(
    roots: &Roots,
    db: &MemoryDb,
    freeze: &crate::data_gate::Freeze,
) -> Result<SnapshotInfo, String> {
    freeze.assert_owner();
    let backups = roots.config.join("backups");
    ensure_no_symlinks(&backups)?;
    fs::create_dir_all(&backups).map_err(error)?;
    let staging = tempfile::Builder::new()
        .prefix(".snapshot-")
        .tempdir_in(&backups)
        .map_err(error)?;
    let id = staging
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .trim_start_matches('.')
        .to_string();
    let final_dir = backups.join(&id);
    let mut entries = inventory(roots)?;
    if !entries.iter().any(|e| e.path == "pet-state.json") {
        entries.push(FileEntry {
            root: "config".into(),
            path: "pet-state.json".into(),
            owner: "pet".into(),
            bytes: 0,
            sha256: String::new(),
        });
    }
    entries.push(FileEntry {
        root: "sqlite".into(),
        path: "memory.db".into(),
        owner: "memory".into(),
        bytes: 0,
        sha256: String::new(),
    });
    let mut total = 0;
    for entry in &mut entries {
        let target = stored(staging.path(), entry);
        fs::create_dir_all(target.parent().unwrap()).map_err(error)?;
        if entry.root == "sqlite" {
            db.0.lock()
                .map_err(error)?
                .backup("main", &target, None)
                .map_err(error)?;
        } else if entry.path == "app-settings.json" {
            let mut settings: crate::app_settings::AppSettings =
                serde_json::from_slice(&fs::read(source(roots, entry)).map_err(error)?)
                    .map_err(error)?;
            settings.has_api_key = false;
            settings.credential_error = None;
            atomic_bytes(&target, &serde_json::to_vec(&settings).map_err(error)?)?;
        } else if entry.path == "pet-state.json" && !source(roots, entry).exists() {
            atomic_bytes(
                &target,
                &serde_json::to_vec(&crate::pet_state::empty_initialized()).map_err(error)?,
            )?;
        } else {
            fs::copy(source(roots, entry), &target).map_err(error)?;
            fs::OpenOptions::new()
                .write(true)
                .open(&target)
                .and_then(|file| file.sync_all())
                .map_err(error)?;
        }
        let (size, hash) = digest(&target)?;
        entry.bytes = size;
        entry.sha256 = hash;
        total += size;
        if total > MAX_BYTES {
            return Err("完整备份超过 2 GiB 限制".into());
        }
    }
    let manifest = Manifest {
        schema_version: VERSION,
        app_version: env!("CARGO_PKG_VERSION").into(),
        id: id.clone(),
        created_at: crate::common::unix_timestamp(),
        files: entries,
    };
    atomic_bytes(
        &staging.path().join("manifest.json"),
        &serde_json::to_vec_pretty(&manifest).map_err(error)?,
    )?;
    fs::rename(staging.path(), &final_dir).map_err(error)?;
    Ok(info(&final_dir, &manifest))
}
fn load(directory: &Path) -> Result<Manifest, String> {
    load_version(directory, false)
}
fn load_version(directory: &Path, recovery: bool) -> Result<Manifest, String> {
    ensure_no_symlinks(directory)?;
    let manifest_path = directory.join("manifest.json");
    ensure_no_symlinks(&manifest_path)?;
    if fs::metadata(&manifest_path).map_err(error)?.len() > 8 * 1024 * 1024 {
        return Err("快照清单过大".into());
    }
    let manifest: Manifest =
        serde_json::from_slice(&fs::read(manifest_path).map_err(error)?).map_err(error)?;
    if manifest.schema_version != VERSION
        || (!recovery && manifest.app_version != env!("CARGO_PKG_VERSION"))
        || (recovery
            && crate::app_updates::version_parts(&manifest.app_version)
                > crate::app_updates::version_parts(env!("CARGO_PKG_VERSION")))
    {
        return Err("快照格式或应用版本不兼容".into());
    }
    if manifest.files.len() > MAX_FILES {
        return Err("快照文件数量超过限制".into());
    }
    let mut paths = std::collections::HashSet::new();
    let mut total = 0;
    let mut sqlite = false;
    for entry in &manifest.files {
        if !valid_entry(entry) || !paths.insert((entry.root.clone(), entry.path.clone())) {
            return Err("快照包含无效或重复的数据路径".into());
        }
        let file = stored(directory, entry);
        ensure_no_symlinks(&file)?;
        let (size, hash) = digest(&file)?;
        if size != entry.bytes || hash != entry.sha256 {
            return Err(format!("快照校验失败：{}", entry.path));
        }
        total += size;
        if total > MAX_BYTES {
            return Err("快照超过大小限制".into());
        }
        if entry.root == "sqlite" {
            sqlite = true;
            let conn = rusqlite::Connection::open_with_flags(
                file,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .map_err(error)?;
            let check: String = conn
                .query_row("PRAGMA quick_check", [], |row| row.get(0))
                .map_err(error)?;
            if check != "ok" {
                return Err("记忆数据库校验失败".into());
            }
        } else if file.extension().and_then(|e| e.to_str()) == Some("json") {
            let _: serde_json::Value =
                serde_json::from_slice(&fs::read(file).map_err(error)?).map_err(error)?;
        }
    }
    if !sqlite {
        return Err("快照缺少记忆数据库".into());
    }
    Ok(manifest)
}
fn revoke_agent_authorizations(roots: &Roots) -> Result<(), String> {
    let directory = roots.data.join("agent/operations");
    if !directory.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(directory).map_err(error)? {
        let path = entry.map_err(error)?.path();
        ensure_no_symlinks(&path)?;
        if path.is_dir() {
            atomic_bytes(&path.join("generation.json"),serde_json::json!({"epoch":format!("restored-{}-{:?}",crate::common::unix_timestamp(),std::time::SystemTime::now())}).to_string().as_bytes())?;
        }
    }
    Ok(())
}
fn apply(
    roots: &Roots,
    directory: &Path,
    manifest: &Manifest,
    db: Option<&MemoryDb>,
) -> Result<(), String> {
    let selected: std::collections::HashSet<_> = manifest
        .files
        .iter()
        .filter(|e| e.root != "sqlite")
        .map(|e| (e.root.clone(), e.path.clone()))
        .collect();
    for old in inventory(roots)? {
        if !selected.contains(&(old.root.clone(), old.path.clone())) {
            fs::remove_file(source(roots, &old)).map_err(error)?;
        }
    }
    for entry in manifest.files.iter().filter(|e| e.root != "sqlite") {
        copy_atomic(&stored(directory, entry), &source(roots, entry))?;
    }
    let sqlite = manifest
        .files
        .iter()
        .find(|e| e.root == "sqlite")
        .ok_or("快照缺少数据库")?;
    let image = stored(directory, sqlite);
    if let Some(db) = db {
        let mut conn = db.0.lock().map_err(error)?;
        conn.restore("main", &image, None::<fn(rusqlite::backup::Progress)>)
            .map_err(error)?;
        crate::memory::vault::pause_after_restore(&conn)?;
    } else {
        // Startup recovery happens before any connection opens, so stale WAL files must not replay.
        for suffix in ["-wal", "-shm"] {
            let path = roots.config.join(format!("memory.db{suffix}"));
            if path.exists() {
                fs::remove_file(path).map_err(error)?;
            }
        }
        copy_atomic(&image, &roots.config.join("memory.db"))?;
        let conn = rusqlite::Connection::open(roots.config.join("memory.db")).map_err(error)?;
        crate::memory::vault::pause_after_restore(&conn)?;
    }
    crate::storage::invalidate_all();
    revoke_agent_authorizations(roots)?;
    Ok(())
}
fn recovery_path(roots: &Roots) -> PathBuf {
    roots.config.join("data-recovery.json")
}
pub(crate) fn recover_before_start(app: &AppHandle) -> Result<(), String> {
    let roots = roots(app)?;
    recover(&roots)?;
    let backups = roots.config.join("backups");
    if backups.exists() {
        for entry in fs::read_dir(backups).map_err(error)? {
            let entry = entry.map_err(error)?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if (name.starts_with(".snapshot-") || name.starts_with(".restore-"))
                && entry.file_type().map_err(error)?.is_dir()
            {
                ensure_no_symlinks(&entry.path())?;
                fs::remove_dir_all(entry.path()).map_err(error)?;
            }
        }
    }
    Ok(())
}
fn recover(roots: &Roots) -> Result<(), String> {
    let journal = recovery_path(roots);
    if !journal.exists() {
        return Ok(());
    }
    let mut recovery: Recovery =
        serde_json::from_slice(&fs::read(&journal).map_err(error)?).map_err(error)?;
    let safe_id = |id: &str| valid_relative(id) && id.starts_with("snapshot-") && !id.contains('/');
    if !safe_id(&recovery.rollback_id)
        || recovery.restore_id.as_ref().is_some_and(|id| !safe_id(id))
    {
        return Err("恢复日志无效，已保留现场".into());
    }
    let rollback_dir = roots.config.join("backups").join(&recovery.rollback_id);
    let rollback = load_version(&rollback_dir, true)?;
    let freeze = crate::data_gate::freeze(Duration::from_secs(1))?;
    if !recovery.applying {
        if let Some(id) = &recovery.restore_id {
            let target = roots.config.join("backups").join(id);
            let manifest = load_version(&target, true)?;
            recovery.applying = true;
            atomic_bytes(&journal, &serde_json::to_vec(&recovery).map_err(error)?)?;
            if let Err(failed) = apply(roots, &target, &manifest, None) {
                apply(roots, &rollback_dir, &rollback, None)?;
                fs::remove_file(&journal).map_err(error)?;
                return Err(format!("恢复失败，已回滚：{failed}"));
            }
        } else {
            apply(roots, &rollback_dir, &rollback, None)?;
        }
    } else {
        apply(roots, &rollback_dir, &rollback, None)?;
    }
    freeze.assert_owner();
    fs::remove_file(journal).map_err(error)?;
    Ok(())
}
/// Multi-file commands are atomic to observers and rollback on failure or the next startup after a crash.
pub(crate) fn transaction<T>(
    app: &AppHandle,
    db: &MemoryDb,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    transaction_at(&roots(app)?, db, operation)
}
fn transaction_at<T>(
    roots: &Roots,
    db: &MemoryDb,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let freeze = crate::data_gate::freeze(Duration::from_millis(500))?;
    let before = capture(roots, db, &freeze)?;
    let journal = recovery_path(roots);
    atomic_bytes(
        &journal,
        &serde_json::to_vec(&Recovery {
            rollback_id: before.id,
            restore_id: None,
            applying: true,
        })
        .map_err(error)?,
    )?;
    match operation() {
        Ok(value) => {
            fs::remove_file(journal).map_err(error)?;
            Ok(value)
        }
        Err(failed) => {
            let directory = Path::new(&before.directory);
            let manifest = load(directory)?;
            apply(roots, directory, &manifest, Some(db))?;
            fs::remove_file(journal).map_err(error)?;
            Err(failed)
        }
    }
}

#[tauri::command]
pub(crate) async fn create_data_snapshot(
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
) -> Result<SnapshotInfo, String> {
    let db = db.inner().clone();
    crate::background::SUPERVISOR
        .blocking("data-snapshot", move || {
            let freeze = crate::data_gate::freeze(Duration::from_millis(500))?;
            capture(&roots(&app)?, &db, &freeze)
        })
        .await
}
#[tauri::command]
pub(crate) async fn preview_data_snapshot(directory: String) -> Result<SnapshotInfo, String> {
    crate::background::SUPERVISOR
        .blocking("snapshot-preview", move || {
            let directory = Path::new(&directory);
            let manifest = load(directory)?;
            Ok(info(directory, &manifest))
        })
        .await
}
#[tauri::command]
pub(crate) async fn restore_data_snapshot(
    app: AppHandle,
    db: State<'_, Arc<MemoryDb>>,
    directory: String,
) -> Result<RestoreResult, String> {
    let db = db.inner().clone();
    crate::background::SUPERVISOR
        .blocking("snapshot-restore", move || {
            let roots = roots(&app)?;
            let directory = Path::new(&directory);
            let manifest = load(directory)?;
            let freeze = crate::data_gate::freeze(Duration::from_millis(500))?;
            let rollback = capture(&roots, &db, &freeze)?;
            // Copy the requested image into our own backup area and revalidate before recording intent.
            let staging = tempfile::Builder::new()
                .prefix(".restore-")
                .tempdir_in(roots.config.join("backups"))
                .map_err(error)?;
            for entry in &manifest.files {
                copy_atomic(&stored(directory, entry), &stored(staging.path(), entry))?;
            }
            let mut staged_manifest = manifest.clone();
            staged_manifest.id = format!(
                "snapshot-{}",
                staging
                    .path()
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .trim_start_matches('.')
            );
            atomic_bytes(
                &staging.path().join("manifest.json"),
                &serde_json::to_vec(&staged_manifest).map_err(error)?,
            )?;
            load(staging.path())?;
            let final_dir = roots.config.join("backups").join(&staged_manifest.id);
            fs::rename(staging.path(), final_dir).map_err(error)?;
            atomic_bytes(
                &recovery_path(&roots),
                &serde_json::to_vec(&Recovery {
                    rollback_id: rollback.id.clone(),
                    restore_id: Some(staged_manifest.id),
                    applying: false,
                })
                .map_err(error)?,
            )?;
            let _ = app.emit("data-restore-pending", ());
            let restart = app.clone();
            crate::background::SUPERVISOR.spawn("restart-after-restore", move |_| {
                std::thread::sleep(Duration::from_millis(300));
                restart.request_restart();
                Ok(())
            });
            crate::background::SUPERVISOR.cancel();
            Ok(RestoreResult {
                rollback,
                restored_files: manifest.files.len(),
                restart_required: true,
            })
        })
        .await
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DataHealth {
    pub memory_persistent: bool,
    pub sqlite: crate::data_gate::LockMetrics,
    pub json_lock_acquisitions: u64,
    pub json_lock_wait_micros: u64,
    pub speech_recognition: bool,
    pub wasm_plugins: bool,
}
pub(crate) struct MemoryPersistence(pub bool);
#[tauri::command]
pub(crate) fn get_data_health(app: AppHandle, db: State<'_, Arc<MemoryDb>>) -> DataHealth {
    let (count, wait) = crate::storage::lock_metrics();
    DataHealth {
        memory_persistent: app
            .try_state::<MemoryPersistence>()
            .is_some_and(|state| state.0),
        sqlite: db.0.metrics(),
        json_lock_acquisitions: count,
        json_lock_wait_micros: wait,
        speech_recognition: cfg!(feature = "speech-recognition"),
        wasm_plugins: cfg!(feature = "wasm-plugins"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unowned_paths_and_detects_tampering() {
        let _test = crate::data_gate::TEST_FREEZE
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let roots = Roots {
            config: dir.path().join("config"),
            data: dir.path().join("data"),
        };
        fs::create_dir_all(&roots.config).unwrap();
        fs::write(roots.config.join("memos.json"), "[]").unwrap();
        let db = crate::memory::open_in_memory_db().unwrap();
        let freeze = crate::data_gate::freeze(Duration::from_secs(2)).unwrap();
        let snapshot = capture(&roots, &db, &freeze).unwrap();
        drop(freeze);
        let manifest = load(Path::new(&snapshot.directory)).unwrap();
        assert!(manifest.files.iter().all(valid_entry));
        assert!(!manifest
            .files
            .iter()
            .any(|e| e.path.contains("credentials")));
        fs::write(
            Path::new(&snapshot.directory).join("config/memos.json"),
            "changed",
        )
        .unwrap();
        assert!(load(Path::new(&snapshot.directory)).is_err());
        let bad = FileEntry {
            root: "config".into(),
            path: "../api-credentials.json".into(),
            owner: "bad".into(),
            bytes: 0,
            sha256: String::new(),
        };
        assert!(!valid_entry(&bad));
    }
    #[test]
    fn complete_snapshot_and_crash_recovery_restore_json_and_sqlite() {
        let _test = crate::data_gate::TEST_FREEZE
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let roots = Roots {
            config: dir.path().join("config"),
            data: dir.path().join("data"),
        };
        fs::create_dir_all(&roots.config).unwrap();
        fs::write(roots.config.join("memos.json"), "[]").unwrap();
        let db = crate::memory::open_in_memory_db().unwrap();
        let freeze = crate::data_gate::freeze(Duration::from_secs(2)).unwrap();
        let snapshot = capture(&roots, &db, &freeze).unwrap();
        drop(freeze);
        fs::write(roots.config.join("memos.json"), "[1]").unwrap();
        let links_marker = roots
            .config
            .join("chat-sessions.conversation-links-v1.json");
        fs::write(&links_marker, r#"{"version":1}"#).unwrap();
        atomic_bytes(
            &recovery_path(&roots),
            &serde_json::to_vec(&Recovery {
                rollback_id: snapshot.id,
                restore_id: None,
                applying: true,
            })
            .unwrap(),
        )
        .unwrap();
        recover(&roots).unwrap();
        assert!(
            !links_marker.exists(),
            "restoring pre-migration data must allow link migration again"
        );
        assert_eq!(
            fs::read_to_string(roots.config.join("memos.json")).unwrap(),
            "[]"
        );
        assert!(!recovery_path(&roots).exists());
        assert!(roots.config.join("memory.db").exists());
    }
}

#[cfg(test)]
mod transaction_tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Roots, MemoryDb) {
        let dir = tempfile::tempdir().unwrap();
        let roots = Roots {
            config: dir.path().join("config"),
            data: dir.path().join("data"),
        };
        fs::create_dir_all(&roots.config).unwrap();
        fs::write(roots.config.join("memos.json"), "[]").unwrap();
        let db = crate::memory::open_in_memory_db().unwrap();
        db.0.lock()
            .unwrap()
            .execute_batch(
                "CREATE TABLE backup_probe(value INTEGER); INSERT INTO backup_probe VALUES(1)",
            )
            .unwrap();
        (dir, roots, db)
    }
    #[test]
    fn failing_multi_store_write_rolls_back_json_and_sqlite() {
        let _test = crate::data_gate::TEST_FREEZE
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let (_dir, roots, db) = fixture();
        let result: Result<(), String> = transaction_at(&roots, &db, || {
            crate::storage::write(
                &roots.config.join("memos.json"),
                &serde_json::json!(["partial"]),
            )?;
            db.0.lock()
                .unwrap()
                .execute("UPDATE backup_probe SET value=9", [])
                .unwrap();
            Err("injected disk failure".into())
        });
        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(roots.config.join("memos.json")).unwrap(),
            "[]"
        );
        assert_eq!(
            db.0.lock()
                .unwrap()
                .query_row("SELECT value FROM backup_probe", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(!recovery_path(&roots).exists());
    }
    #[test]
    fn pending_restore_applies_on_boot_and_invalidates_saved_approvals() {
        let _test = crate::data_gate::TEST_FREEZE
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let (_dir, roots, db) = fixture();
        let operation = roots.data.join("agent/operations/probe");
        fs::create_dir_all(&operation).unwrap();
        fs::write(operation.join("generation.json"), "{\"epoch\":\"old\"}").unwrap();
        let freeze = crate::data_gate::freeze(Duration::from_secs(2)).unwrap();
        let target = capture(&roots, &db, &freeze).unwrap();
        drop(freeze);
        fs::write(roots.config.join("memos.json"), "[2]").unwrap();
        db.0.lock()
            .unwrap()
            .execute("UPDATE backup_probe SET value=2", [])
            .unwrap();
        let freeze = crate::data_gate::freeze(Duration::from_secs(2)).unwrap();
        let rollback = capture(&roots, &db, &freeze).unwrap();
        drop(freeze);
        atomic_bytes(
            &recovery_path(&roots),
            &serde_json::to_vec(&Recovery {
                rollback_id: rollback.id,
                restore_id: Some(target.id),
                applying: false,
            })
            .unwrap(),
        )
        .unwrap();
        recover(&roots).unwrap();
        assert_eq!(
            fs::read_to_string(roots.config.join("memos.json")).unwrap(),
            "[]"
        );
        let restored = rusqlite::Connection::open(roots.config.join("memory.db")).unwrap();
        assert_eq!(
            restored
                .query_row("SELECT value FROM backup_probe", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        let generation: serde_json::Value =
            serde_json::from_slice(&fs::read(operation.join("generation.json")).unwrap()).unwrap();
        assert_ne!(generation["epoch"], "old");
    }
    #[test]
    fn snapshots_exclude_credentials_workspace_files_and_diagnostics() {
        let _test = crate::data_gate::TEST_FREEZE
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let (_dir, roots, db) = fixture();
        fs::write(roots.config.join("api-credentials.json"), "private-key").unwrap();
        for folder in ["agent/workspace", "agent/diagnostics"] {
            fs::create_dir_all(roots.data.join(folder)).unwrap();
            fs::write(roots.data.join(folder).join("private.txt"), "excluded").unwrap();
        }
        let freeze = crate::data_gate::freeze(Duration::from_secs(2)).unwrap();
        let snapshot = capture(&roots, &db, &freeze).unwrap();
        drop(freeze);
        let manifest = load(Path::new(&snapshot.directory)).unwrap();
        assert!(
            !manifest.files.iter().any(|e| e.path.contains("credentials")
                || e.path.contains("workspace")
                || e.path.contains("diagnostics"))
        );
    }
}
