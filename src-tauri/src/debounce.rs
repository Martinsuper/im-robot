use std::{
    sync::mpsc::{self, RecvTimeoutError, SyncSender},
    time::Duration,
};

/// One worker per window; bursts never allocate an OS thread per event.
pub(crate) struct Debouncer(SyncSender<()>);

impl Debouncer {
    pub fn new(delay: Duration, mut action: impl FnMut() + Send + 'static) -> Self {
        let (sender, receiver) = mpsc::sync_channel(1);
        crate::background::SUPERVISOR.spawn_effect("debounce", move |worker| {
            while !worker.cancelled() {
                match receiver.recv_timeout(Duration::from_millis(100)) {
                    Ok(()) => (),
                    Err(RecvTimeoutError::Timeout) => continue,
                    Err(_) => break,
                }
                let mut deadline = std::time::Instant::now() + delay;
                while !worker.cancelled() {
                    match receiver.recv_timeout(
                        deadline
                            .saturating_duration_since(std::time::Instant::now())
                            .min(Duration::from_millis(100)),
                    ) {
                        Ok(()) => {
                            deadline = std::time::Instant::now() + delay;
                            continue;
                        }
                        Err(RecvTimeoutError::Timeout) => {
                            if std::time::Instant::now() < deadline {
                                continue;
                            }
                            action();
                            break;
                        }
                        Err(RecvTimeoutError::Disconnected) => {
                            action();
                            return;
                        }
                    }
                }
            }
        });
        Self(sender)
    }
    pub fn trigger(&self) {
        let _ = self.0.try_send(());
    }
}
