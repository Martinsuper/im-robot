//! Serialized JSON transactions, cached reads and durable atomic replacement.
//! Keep the transaction guard across the entire read/modify/write sequence.
use parking_lot::{ReentrantMutex, ReentrantMutexGuard};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::SystemTime,
};

static TRANSACTION: ReentrantMutex<()> = ReentrantMutex::new(());
static CHANGES: (Mutex<u64>, std::sync::Condvar) = (Mutex::new(0), std::sync::Condvar::new());
static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(|| Mutex::new(Cache::default()));
#[derive(Default)]
struct Cache {
    entries: HashMap<PathBuf, (Option<SystemTime>, u64, Value)>,
    unreadable: HashSet<PathBuf>,
}

pub(crate) struct Transaction {
    _guard: ReentrantMutexGuard<'static, ()>,
    _lease: crate::data_gate::ReadLease,
}
pub(crate) fn transaction() -> Transaction {
    let lease = crate::data_gate::read();
    let started = std::time::Instant::now();
    let guard = TRANSACTION.lock();
    JSON_LOCK_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    JSON_LOCK_WAIT.fetch_add(
        started.elapsed().as_micros().min(u64::MAX as u128) as u64,
        std::sync::atomic::Ordering::Relaxed,
    );
    Transaction {
        _guard: guard,
        _lease: lease,
    }
}

pub(crate) fn revision() -> u64 {
    *CHANGES.0.lock().unwrap_or_else(|e| e.into_inner())
}
pub(crate) fn wait_for_change(revision: u64, timeout: std::time::Duration) {
    let guard = CHANGES.0.lock().unwrap_or_else(|e| e.into_inner());
    let _ = CHANGES
        .1
        .wait_timeout_while(guard, timeout, |current| *current == revision);
}

/// Storage revisions wake timers immediately; bounded slices also observe process shutdown.
pub(crate) fn wait_for_change_until(
    revision: u64,
    timeout: std::time::Duration,
    cancelled: impl Fn() -> bool,
) {
    let deadline = std::time::Instant::now() + timeout;
    while self::revision() == revision && !cancelled() {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        wait_for_change(
            revision,
            remaining.min(std::time::Duration::from_millis(100)),
        );
    }
}

pub(crate) fn read<T: DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
    let _transaction = transaction();
    let result = (|| {
        let metadata = match fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(T::default()),
            Err(error) => return Err(error.to_string()),
        };
        let modified = metadata.modified().ok();
        let mut cache = CACHE.lock().map_err(|e| e.to_string())?;
        if let Some((time, size, value)) = cache.entries.get(path) {
            if modified.is_some() && *time == modified && *size == metadata.len() {
                return serde_json::from_value(value.clone()).map_err(|e| e.to_string());
            }
        }
        let value: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let decoded = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
        cache
            .entries
            .insert(path.to_owned(), (modified, metadata.len(), value));
        Ok(decoded)
    })();
    let mut cache = CACHE.lock().map_err(|e| e.to_string())?;
    if result.is_err() {
        cache.unreadable.insert(path.to_owned());
    } else {
        cache.unreadable.remove(path);
    }
    result.map_err(|e: String| format!("无法读取 {}：{e}。原文件已保留。", path.display()))
}

pub(crate) fn read_or_default<T: DeserializeOwned + Default>(path: &Path) -> T {
    read(path).unwrap_or_else(|error| {
        eprintln!("[storage] {error}");
        T::default()
    })
}

pub(crate) fn write<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), String> {
    let _transaction = transaction();
    if CACHE
        .lock()
        .map_err(|e| e.to_string())?
        .unreadable
        .contains(path)
    {
        return Err(format!(
            "{} 读取失败，已阻止覆盖；请先恢复原文件。",
            path.display()
        ));
    }
    if path.exists() {
        // Never overwrite a corrupt file, including on the first write after startup.
        let _: Value = read(path)?;
    }
    let directory = path.parent().ok_or("无法获取数据目录")?;
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut file, value).map_err(|e| e.to_string())?;
    file.flush().map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    fs::File::open(directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|e| e.to_string())?;
    CACHE
        .lock()
        .map_err(|e| e.to_string())?
        .entries
        .remove(path);
    *CHANGES.0.lock().unwrap_or_else(|e| e.into_inner()) += 1;
    CHANGES.1.notify_all();
    Ok(())
}

/// Called after an exclusive restore, before any observer is allowed to read again.
pub(crate) fn invalidate_all() {
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Cache::default();
    *CHANGES.0.lock().unwrap_or_else(|e| e.into_inner()) += 1;
    CHANGES.1.notify_all();
}

static JSON_LOCK_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static JSON_LOCK_WAIT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub(crate) fn lock_metrics() -> (u64, u64) {
    use std::sync::atomic::Ordering::Relaxed;
    (JSON_LOCK_COUNT.load(Relaxed), JSON_LOCK_WAIT.load(Relaxed))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn concurrent_transactions_do_not_lose_records() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("records.json");
        let workers: Vec<_> = (0..12)
            .map(|id| {
                let path = path.clone();
                std::thread::spawn(move || {
                    let _guard = transaction();
                    let mut records: Vec<usize> = read(&path).unwrap();
                    records.push(id);
                    write(&path, &records).unwrap();
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(read::<Vec<usize>>(&path).unwrap().len(), 12);
    }
    #[test]
    fn corruption_is_reported_and_never_overwritten() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("records.json");
        fs::write(&path, "{broken").unwrap();
        assert!(read::<Vec<usize>>(&path).is_err());
        assert!(write(&path, &[1]).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{broken");
    }
    #[test]
    fn cache_observes_external_atomic_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("records.json");
        write(&path, &[1]).unwrap();
        assert_eq!(read::<Vec<usize>>(&path).unwrap(), vec![1]);
        let replacement = directory.path().join("replacement.json");
        fs::write(&replacement, "[2,3]").unwrap();
        fs::rename(replacement, &path).unwrap();
        assert_eq!(read::<Vec<usize>>(&path).unwrap(), vec![2, 3]);
    }
}
