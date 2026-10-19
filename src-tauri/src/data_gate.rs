//! Shared data operations remain concurrent; a short exclusive freeze creates a consistent snapshot.
use std::{
    ops::{Deref, DerefMut},
    sync::{Condvar, LazyLock, LockResult, Mutex, MutexGuard, PoisonError},
    thread::ThreadId,
    time::{Duration, Instant},
};
#[derive(Default)]
struct State {
    readers: usize,
    owner: Option<ThreadId>,
}
#[derive(Default)]
struct Gate {
    state: Mutex<State>,
    changed: Condvar,
}
static GATE: LazyLock<Gate> = LazyLock::new(Gate::default);

// Tests using the process-wide freeze must not contend with unrelated fixtures.
#[cfg(test)]
pub(crate) static TEST_FREEZE: Mutex<()> = Mutex::new(());
pub(crate) struct ReadLease {
    counted: bool,
}
pub(crate) struct Freeze(std::marker::PhantomData<std::rc::Rc<()>>);
pub(crate) fn read() -> ReadLease {
    let mut state = GATE.state.lock().unwrap_or_else(|e| e.into_inner());
    let me = std::thread::current().id();
    while state.owner.is_some_and(|owner| owner != me) {
        state = GATE.changed.wait(state).unwrap_or_else(|e| e.into_inner());
    }
    let counted = state.owner != Some(me);
    if counted {
        state.readers += 1;
    }
    ReadLease { counted }
}
pub(crate) fn try_read() -> Result<ReadLease, String> {
    let mut state = GATE.state.lock().map_err(|_| "data_gate_unavailable")?;
    if state.owner.is_some() {
        return Err("数据正在备份或恢复，请稍后重试".into());
    }
    state.readers += 1;
    Ok(ReadLease { counted: true })
}
pub(crate) fn freeze(timeout: Duration) -> Result<Freeze, String> {
    let deadline = Instant::now() + timeout;
    let mut state = GATE.state.lock().map_err(|_| "data_gate_unavailable")?;
    loop {
        if state.owner.is_none() && state.readers == 0 {
            state.owner = Some(std::thread::current().id());
            return Ok(Freeze(std::marker::PhantomData));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("数据正在使用中，请等待当前任务结束后重试".into());
        }
        state = GATE
            .changed
            .wait_timeout(state, remaining)
            .map_err(|_| "data_gate_unavailable")?
            .0;
    }
}
impl Drop for ReadLease {
    fn drop(&mut self) {
        if self.counted {
            let mut state = GATE.state.lock().unwrap_or_else(|e| e.into_inner());
            state.readers -= 1;
            GATE.changed.notify_all();
        }
    }
}
impl Drop for Freeze {
    fn drop(&mut self) {
        let mut state = GATE.state.lock().unwrap_or_else(|e| e.into_inner());
        debug_assert_eq!(state.owner, Some(std::thread::current().id()));
        state.owner = None;
        GATE.changed.notify_all();
    }
}
// This guard is deliberately !Send: the reentrant exclusive owner is a thread identity.
impl Freeze {
    pub fn assert_owner(&self) {
        assert_eq!(
            GATE.state.lock().unwrap_or_else(|e| e.into_inner()).owner,
            Some(std::thread::current().id())
        );
    }
}
/// Wrap every database connection use so snapshots cannot race SQLite or cross-store writers.
#[derive(Default)]
struct Metrics {
    count: std::sync::atomic::AtomicU64,
    wait: std::sync::atomic::AtomicU64,
    hold: std::sync::atomic::AtomicU64,
}
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LockMetrics {
    pub acquisitions: u64,
    pub wait_micros: u64,
    pub hold_micros: u64,
}
pub(crate) struct DataMutex<T>(Mutex<T>, Metrics);
impl<T> DataMutex<T> {
    pub fn new(value: T) -> Self {
        Self(Mutex::new(value), Metrics::default())
    }
    pub fn metrics(&self) -> LockMetrics {
        use std::sync::atomic::Ordering::Relaxed;
        LockMetrics {
            acquisitions: self.1.count.load(Relaxed),
            wait_micros: self.1.wait.load(Relaxed),
            hold_micros: self.1.hold.load(Relaxed),
        }
    }
    pub fn lock(&self) -> LockResult<DataGuard<'_, T>> {
        let lease = read();
        let started = Instant::now();
        let result = self.0.lock();
        use std::sync::atomic::Ordering::Relaxed;
        self.1.count.fetch_add(1, Relaxed);
        self.1.wait.fetch_add(
            started.elapsed().as_micros().min(u64::MAX as u128) as u64,
            Relaxed,
        );
        match result {
            Ok(guard) => Ok(DataGuard {
                guard,
                _lease: lease,
                metrics: &self.1,
                started: Instant::now(),
            }),
            Err(error) => Err(PoisonError::new(DataGuard {
                guard: error.into_inner(),
                _lease: lease,
                metrics: &self.1,
                started: Instant::now(),
            })),
        }
    }
}
pub(crate) struct DataGuard<'a, T> {
    guard: MutexGuard<'a, T>,
    _lease: ReadLease,
    metrics: &'a Metrics,
    started: Instant,
}
impl<T> Deref for DataGuard<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.guard
    }
}
impl<T> DerefMut for DataGuard<'_, T> {
    fn deref_mut(&mut self) -> &mut T {
        &mut self.guard
    }
}
impl<T> Drop for DataGuard<'_, T> {
    fn drop(&mut self) {
        self.metrics.hold.fetch_add(
            self.started.elapsed().as_micros().min(u64::MAX as u128) as u64,
            std::sync::atomic::Ordering::Relaxed,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn active_writers_block_freeze_and_owner_can_use_storage() {
        let _test = TEST_FREEZE
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let lease = read();
        assert!(freeze(Duration::from_millis(1)).is_err());
        drop(lease);
        let guard = freeze(Duration::from_secs(1)).unwrap();
        guard.assert_owner();
        let nested = read();
        drop(nested);
        drop(guard);
    }
}
