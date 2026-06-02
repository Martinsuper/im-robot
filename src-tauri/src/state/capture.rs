use crate::types::ScreenCapture;
use std::sync::Mutex;

#[derive(Default)]
pub struct ScreenCaptureStore(pub Mutex<Option<ScreenCapture>>);
