use std::{sync::mpsc, time::Duration};

use block2::RcBlock;
use image::RgbaImage;
use objc2::AllocAnyThread;
use objc2_core_foundation::CGRect;
use objc2_core_graphics::{CGDataProvider, CGDisplayBounds, CGImage};
use objc2_foundation::{NSArray, NSError};
use objc2_screen_capture_kit::{
    SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration,
};

use crate::error::{XCapError, XCapResult};

/// Capture a window or a display region using macOS 14's single-frame API.
/// Display regions use global Core Graphics points; window IDs capture the
/// window independently of occluding windows. Callbacks never block the main queue.
pub fn capture(rect: CGRect, display_id: u32, window_id: Option<u32>) -> XCapResult<RgbaImage> {
    let (tx, rx) = mpsc::sync_channel(1);
    let content_handler = RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            // SAFETY: ScreenCaptureKit supplies live objects for the callback duration.
            // All Objective-C references are consumed here, never sent across threads.
            unsafe {
                if let Some(error) = error.as_ref() {
                    let _ = tx.send(Err(XCapError::new(
                        error.localizedDescription().to_string(),
                    )));
                    return;
                }
                let Some(content) = content.as_ref() else {
                    let _ = tx.send(Err(XCapError::new("ScreenCaptureKit returned no content")));
                    return;
                };
                let filter = if let Some(id) = window_id {
                    let windows = content.windows();
                    let Some(window) = windows.iter().find(|window| window.windowID() == id) else {
                        let _ =
                            tx.send(Err(XCapError::new("Capture window is no longer available")));
                        return;
                    };
                    SCContentFilter::initWithDesktopIndependentWindow(
                        SCContentFilter::alloc(),
                        &window,
                    )
                } else {
                    let displays = content.displays();
                    let Some(display) = displays
                        .iter()
                        .find(|display| display.displayID() == display_id)
                    else {
                        let _ = tx.send(Err(XCapError::new(
                            "Capture display is no longer available",
                        )));
                        return;
                    };
                    SCContentFilter::initWithDisplay_excludingWindows(
                        SCContentFilter::alloc(),
                        &display,
                        &NSArray::new(),
                    )
                };
                let config = SCStreamConfiguration::new();
                let scale = f64::from(filter.pointPixelScale());
                let bounds = filter.contentRect();
                let display_bounds = if window_id.is_none() {
                    CGDisplayBounds(display_id)
                } else {
                    rect
                };
                let region = if window_id.is_some() {
                    bounds
                } else {
                    CGRect {
                        origin: objc2_core_foundation::CGPoint {
                            x: rect.origin.x - display_bounds.origin.x,
                            y: rect.origin.y - display_bounds.origin.y,
                        },
                        size: rect.size,
                    }
                };
                config.setWidth((region.size.width * scale).round().max(1.0) as usize);
                config.setHeight((region.size.height * scale).round().max(1.0) as usize);
                if window_id.is_none() {
                    config.setSourceRect(region);
                }
                config.setShowsCursor(false);
                config.setIgnoreShadowsSingleWindow(true);
                let image_tx = tx.clone();
                let image_handler =
                    RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
                        let result = if let Some(error) = error.as_ref() {
                            Err(XCapError::new(error.localizedDescription().to_string()))
                        } else if let Some(image) = image.as_ref() {
                            image_to_rgba(image)
                        } else {
                            Err(XCapError::new("ScreenCaptureKit returned no image"))
                        };
                        let _ = image_tx.send(result);
                    });
                SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(
                    &filter,
                    &config,
                    Some(&image_handler),
                );
            }
        },
    );
    // SAFETY: The framework copies the completion block until completion.
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&content_handler) };
    rx.recv_timeout(Duration::from_secs(15))
        .map_err(|_| XCapError::new("ScreenCaptureKit capture timed out"))?
}

/// Copy the SDR BGRA image returned by ScreenCaptureKit into owned RGBA pixels.
fn image_to_rgba(image: &CGImage) -> XCapResult<RgbaImage> {
    let width = CGImage::width(Some(image));
    let height = CGImage::height(Some(image));
    let provider = CGImage::data_provider(Some(image));
    let data = CGDataProvider::data(provider.as_deref())
        .ok_or_else(|| XCapError::new("Failed to copy screenshot pixels"))?;
    bgra_to_rgba(
        &data.to_vec(),
        width,
        height,
        CGImage::bytes_per_row(Some(image)),
    )
}

/// Validate row layout and discard padding before converting BGRA channels.
fn bgra_to_rgba(data: &[u8], width: usize, height: usize, stride: usize) -> XCapResult<RgbaImage> {
    let row_bytes = width
        .checked_mul(4)
        .ok_or_else(|| XCapError::new("Invalid image width"))?;
    let total = stride
        .checked_mul(height)
        .ok_or_else(|| XCapError::new("Invalid image height"))?;
    if width == 0 || height == 0 || stride < row_bytes || data.len() < total {
        return Err(XCapError::new("Invalid screenshot pixel layout"));
    }
    let mut pixels = Vec::with_capacity(row_bytes * height);
    for row in data[..total].chunks_exact(stride) {
        for pixel in row[..row_bytes].as_chunks::<4>().0 {
            pixels.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
        }
    }
    RgbaImage::from_raw(width as u32, height as u32, pixels)
        .ok_or_else(|| XCapError::new("Failed to create screenshot image"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_bgra_and_skips_row_padding() {
        let image = bgra_to_rgba(&[1, 2, 3, 255, 0, 0, 4, 5, 6, 255, 0, 0], 1, 2, 6).unwrap();
        assert_eq!(image.into_raw(), [3, 2, 1, 255, 6, 5, 4, 255]);
    }

    #[test]
    fn rejects_empty_truncated_and_invalid_rows() {
        for (data, width, height, stride) in [
            (&[][..], 0, 0, 0),
            (&[0; 4][..], 1, 2, 4),
            (&[0; 4][..], 2, 1, 4),
        ] {
            assert!(bgra_to_rgba(data, width, height, stride).is_err());
        }
    }
}
