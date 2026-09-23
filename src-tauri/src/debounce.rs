use std::{
    sync::mpsc::{self, RecvTimeoutError, SyncSender},
    thread,
    time::Duration,
};

/// One worker per window; bursts never allocate an OS thread per event.
pub(crate) struct Debouncer(SyncSender<()>);

impl Debouncer {
    pub fn new(delay: Duration, mut action: impl FnMut() + Send + 'static) -> Self {
        let (sender, receiver) = mpsc::sync_channel(1);
        thread::spawn(move || {
            while receiver.recv().is_ok() {
                loop {
                    match receiver.recv_timeout(delay) {
                        Ok(()) => continue,
                        Err(RecvTimeoutError::Timeout) => {
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
