//! Supervised process-lifetime workers. Every worker has cancellation and observable health.
use futures_util::FutureExt;
use serde::Serialize;
use std::{
    collections::BTreeMap,
    future::Future,
    panic::AssertUnwindSafe,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, LazyLock, Mutex,
    },
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkerStatus {
    pub name: String,
    pub state: String,
    pub last_error: Option<String>,
}
struct Inner {
    statuses: Mutex<BTreeMap<String, WorkerStatus>>,
    wake: Condvar,
    stopped: Mutex<bool>,
    cancel: CancellationToken,
}
#[derive(Clone)]
pub(crate) struct Supervisor(Arc<Inner>);
#[derive(Clone)]
pub(crate) struct Worker {
    supervisor: Supervisor,
    name: String,
}
static NEXT_TASK: AtomicU64 = AtomicU64::new(1);
pub(crate) static SUPERVISOR: LazyLock<Supervisor> = LazyLock::new(Supervisor::new);
impl Supervisor {
    pub fn new() -> Self {
        Self(Arc::new(Inner {
            statuses: Mutex::new(BTreeMap::new()),
            wake: Condvar::new(),
            stopped: Mutex::new(false),
            cancel: CancellationToken::new(),
        }))
    }
    fn register(&self, name: &str) -> Option<Worker> {
        let mut statuses = self.0.statuses.lock().unwrap_or_else(|e| e.into_inner());
        if self.0.cancel.is_cancelled() || statuses.contains_key(name) {
            return None;
        }
        if statuses.len() >= 128 {
            let done: Vec<_> = statuses
                .iter()
                .filter(|(_, s)| s.state == "stopped" || s.state == "failed")
                .map(|(name, _)| name.clone())
                .take(32)
                .collect();
            for name in done {
                statuses.remove(&name);
            }
        }
        statuses.insert(
            name.into(),
            WorkerStatus {
                name: name.into(),
                state: "running".into(),
                last_error: None,
            },
        );
        Some(Worker {
            supervisor: self.clone(),
            name: name.into(),
        })
    }
    pub fn spawn(
        &self,
        name: &str,
        job: impl FnOnce(Worker) -> Result<(), String> + Send + 'static,
    ) {
        let Some(worker) = self.register(name) else {
            return;
        };
        let monitor = worker.clone();
        if let Err(error) = std::thread::Builder::new()
            .name(name.into())
            .spawn(move || {
                let result = std::panic::catch_unwind(AssertUnwindSafe(|| job(worker)))
                    .unwrap_or_else(|_| Err("worker_panicked".into()));
                monitor.finish(result);
            })
        {
            monitor_spawn_failure(self, name, error.to_string());
        }
    }
    pub fn spawn_async<F, Fut>(&self, name: &str, job: F)
    where
        F: FnOnce(Worker) -> Fut + Send + 'static,
        Fut: Future<Output = Result<(), String>> + Send + 'static,
    {
        let Some(worker) = self.register(name) else {
            return;
        };
        let monitor = worker.clone();
        tauri::async_runtime::spawn(async move {
            let result = AssertUnwindSafe(job(worker))
                .catch_unwind()
                .await
                .unwrap_or_else(|_| Err("worker_panicked".into()));
            monitor.finish(result);
        });
    }
    pub fn spawn_effect(&self, name: &str, job: impl FnOnce(Worker) + Send + 'static) {
        self.spawn(
            &format!("{name}:{}", NEXT_TASK.fetch_add(1, Ordering::Relaxed)),
            move |worker| {
                job(worker);
                Ok(())
            },
        );
    }
    pub fn spawn_async_effect<F, Fut>(&self, name: &str, job: F)
    where
        F: FnOnce(Worker) -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        self.spawn_async(
            &format!("{name}:{}", NEXT_TASK.fetch_add(1, Ordering::Relaxed)),
            move |worker| async move {
                job(worker).await;
                Ok(())
            },
        );
    }
    pub async fn blocking<T: Send + 'static>(
        &self,
        name: &str,
        job: impl FnOnce() -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let name = format!("{name}:{}", NEXT_TASK.fetch_add(1, Ordering::Relaxed));
        let monitor = self
            .register(&name)
            .ok_or("应用正在退出，无法启动数据任务")?;
        tauri::async_runtime::spawn_blocking(move || {
            let result = std::panic::catch_unwind(AssertUnwindSafe(job))
                .unwrap_or_else(|_| Err("data_worker_panicked".into()));
            monitor.finish(result.as_ref().map(|_| ()).map_err(Clone::clone));
            result
        })
        .await
        .map_err(|_| "数据任务发生异常".to_string())?
    }
    pub fn token(&self) -> CancellationToken {
        self.0.cancel.clone()
    }
    pub fn statuses(&self) -> Vec<WorkerStatus> {
        self.0
            .statuses
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect()
    }
    pub fn cancel(&self) {
        self.0.cancel.cancel();
        *self.0.stopped.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.0.wake.notify_all();
    }
    pub fn shutdown(&self, timeout: Duration) -> Vec<String> {
        self.cancel();
        let deadline = Instant::now() + timeout;
        let mut stopped = self.0.stopped.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            let running: Vec<_> = self
                .statuses()
                .into_iter()
                .filter(|s| s.state == "running" || s.state == "degraded")
                .map(|s| s.name)
                .collect();
            if running.is_empty() || Instant::now() >= deadline {
                return running;
            }
            let result = self
                .0
                .wake
                .wait_timeout(stopped, deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|e| e.into_inner());
            stopped = result.0;
        }
    }
}
fn monitor_spawn_failure(supervisor: &Supervisor, name: &str, error: String) {
    Worker {
        supervisor: supervisor.clone(),
        name: name.into(),
    }
    .finish(Err(error));
}
impl Worker {
    pub fn cancelled(&self) -> bool {
        self.supervisor.0.cancel.is_cancelled()
    }
    pub fn wait(&self, duration: Duration) -> bool {
        let guard = self
            .supervisor
            .0
            .stopped
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let _ = self
            .supervisor
            .0
            .wake
            .wait_timeout_while(guard, duration, |stopped| !*stopped)
            .unwrap_or_else(|e| e.into_inner());
        !self.cancelled()
    }
    pub async fn sleep(&self, duration: Duration) -> bool {
        tokio::select! { biased; _ = self.supervisor.0.cancel.cancelled() => false, _ = tokio::time::sleep(duration) => true }
    }
    pub fn health(&self, result: Result<(), String>) {
        if let Some(status) = self
            .supervisor
            .0
            .statuses
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(&self.name)
        {
            status.state = if result.is_ok() {
                "running"
            } else {
                "degraded"
            }
            .into();
            status.last_error = result.err().map(|s| s.chars().take(500).collect());
        }
    }
    fn finish(&self, result: Result<(), String>) {
        if let Some(status) = self
            .supervisor
            .0
            .statuses
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(&self.name)
        {
            status.state = if result.is_ok() { "stopped" } else { "failed" }.into();
            status.last_error = result.err();
        }
        // Pair notification with the shutdown wait lock to avoid a missed wakeup.
        let _guard = self
            .supervisor
            .0
            .stopped
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        self.supervisor.0.wake.notify_all();
    }
}
#[tauri::command]
pub(crate) fn background_status() -> Vec<WorkerStatus> {
    SUPERVISOR.statuses()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_wakes_sleepers_and_prevents_new_workers() {
        let supervisor = Supervisor::new();
        supervisor.spawn("timer", |worker| {
            while worker.wait(Duration::from_secs(60)) {}
            Ok(())
        });
        assert!(supervisor.shutdown(Duration::from_secs(1)).is_empty());
        supervisor.spawn("late", |_| Ok(()));
        assert_eq!(supervisor.statuses().len(), 1);
    }
    #[test]
    fn errors_and_panics_are_observable_and_duplicate_start_is_ignored() {
        let supervisor = Supervisor::new();
        supervisor.spawn("broken", |_| Err("disk unavailable".into()));
        supervisor.spawn("broken", |_| panic!("must not run"));
        let until = Instant::now() + Duration::from_secs(1);
        while supervisor.statuses()[0].state == "running" && Instant::now() < until {
            std::thread::yield_now();
        }
        assert_eq!(supervisor.statuses()[0].state, "failed");
        assert_eq!(
            supervisor.statuses()[0].last_error.as_deref(),
            Some("disk unavailable")
        );
    }
}

#[cfg(test)]
mod async_tests {
    use super::*;
    #[test]
    fn shutdown_cancels_async_intervals_without_waiting_for_the_timer() {
        let supervisor = Supervisor::new();
        let started = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let signal = started.clone();
        supervisor.spawn_async("async-interval", move |worker| async move {
            signal.store(true, std::sync::atomic::Ordering::Release);
            while worker.sleep(Duration::from_secs(60)).await {}
            Ok(())
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while !started.load(std::sync::atomic::Ordering::Acquire) && Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert!(started.load(std::sync::atomic::Ordering::Acquire));
        assert!(supervisor.shutdown(Duration::from_secs(2)).is_empty());
        assert_eq!(supervisor.statuses()[0].state, "stopped");
    }
}
