#[cfg(feature = "linux-video")]
use super::wayland_video_recorder::WaylandVideoRecorder;
use std::sync::mpsc::Receiver;

use crate::{XCapResult, video_recorder::Frame};

use super::{
    impl_monitor::ImplMonitor, utils::wayland_detect,
    xorg_video_recorder::XorgVideoRecorder,
};

#[derive(Debug, Clone)]
pub enum ImplVideoRecorder {
    Xorg(XorgVideoRecorder),
    #[cfg(feature = "linux-video")]
    Wayland(WaylandVideoRecorder),
}

impl ImplVideoRecorder {
    pub fn new(monitor: ImplMonitor) -> XCapResult<(Self, Receiver<Frame>)> {
        if wayland_detect() {
            #[cfg(feature = "linux-video")]
            {
                let (recorder, receiver) = WaylandVideoRecorder::new(monitor)?;
                Ok((ImplVideoRecorder::Wayland(recorder), receiver))
            }
            #[cfg(not(feature = "linux-video"))]
            Err(crate::XCapError::new("Wayland video recording is not enabled"))
        } else {
            let (recorder, receiver) = XorgVideoRecorder::new(monitor)?;
            Ok((ImplVideoRecorder::Xorg(recorder), receiver))
        }
    }

    pub fn start(&self) -> XCapResult<()> {
        match self {
            ImplVideoRecorder::Xorg(recorder) => recorder.start(),
            #[cfg(feature = "linux-video")]
            ImplVideoRecorder::Wayland(recorder) => recorder.start(),
        }
    }

    pub fn stop(&self) -> XCapResult<()> {
        match self {
            ImplVideoRecorder::Xorg(recorder) => recorder.stop(),
            #[cfg(feature = "linux-video")]
            ImplVideoRecorder::Wayland(recorder) => recorder.stop(),
        }
    }
}
