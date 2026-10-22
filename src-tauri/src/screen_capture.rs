//! Screen capture permissions, selection and preview state.
use crate::desktop::show_and_focus;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use serde::Deserialize;
use serde::Serialize;
use std::io::Cursor;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tauri::PhysicalPosition;
use tauri::State;
use xcap::image::DynamicImage;
use xcap::Monitor;

#[derive(Clone, Debug)]
pub(crate) struct ScreenCapture {
    pub(crate) data_url: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CaptureSelection {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScreenshotPreview {
    pub(crate) data_url: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

#[derive(Default)]
pub(crate) struct ScreenCaptureStore(
    pub(crate) Mutex<Option<ScreenCapture>>,
    pub(crate) Mutex<Option<String>>,
);

#[cfg(target_os = "macos")]
pub(crate) fn ensure_screen_capture_permission() -> Result<(), String> {
    let access = core_graphics::access::ScreenCaptureAccess;
    if access.preflight() || access.request() {
        Ok(())
    } else {
        Err(
            "Piko 没有屏幕录制权限。请在“系统设置 → 隐私与安全性 → 屏幕录制”中允许 Piko，然后重新启动应用。"
                .to_string(),
        )
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn ensure_screen_capture_permission() -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) fn capture_area_coordinates(
    origin: PhysicalPosition<i32>,
    selection: &CaptureSelection,
    _scale: f64,
) -> (i32, i32, u32, u32) {
    (
        origin.x + selection.x.round() as i32,
        origin.y + selection.y.round() as i32,
        selection.width.round() as u32,
        selection.height.round() as u32,
    )
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn capture_area_coordinates(
    origin: PhysicalPosition<i32>,
    selection: &CaptureSelection,
    scale: f64,
) -> (i32, i32, u32, u32) {
    (
        origin.x + (selection.x * scale).round() as i32,
        origin.y + (selection.y * scale).round() as i32,
        (selection.width * scale).round() as u32,
        (selection.height * scale).round() as u32,
    )
}

#[tauri::command]
pub(crate) fn begin_screen_capture(
    app: AppHandle,
    window: tauri::WebviewWindow,
    captures: State<'_, ScreenCaptureStore>,
) -> Result<(), String> {
    ensure_screen_capture_permission()?;
    let capture = app
        .get_webview_window("capture")
        .ok_or_else(|| "无法打开截图选择窗口".to_string())?;
    if captures.1.lock().map_err(|_| "无法读取截图来源")?.is_some()
        && capture.is_visible().unwrap_or(false)
    {
        return Err("已有截图选择正在进行，请先完成或取消。".into());
    }
    let reference = app
        .get_webview_window("pet")
        .and_then(|window| window.current_monitor().ok().flatten())
        .or_else(|| capture.primary_monitor().ok().flatten())
        .ok_or_else(|| "无法识别当前显示器".to_string())?;

    capture
        .set_position(*reference.position())
        .map_err(|error| error.to_string())?;
    capture
        .set_size(*reference.size())
        .map_err(|error| error.to_string())?;
    *captures.1.lock().map_err(|_| "无法记录截图来源")? = Some(window.label().to_string());
    capture.show().map_err(|error| error.to_string())?;
    capture.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn cancel_screen_capture(app: AppHandle, captures: State<'_, ScreenCaptureStore>) {
    if let Ok(mut owner) = captures.1.lock() {
        *owner = None;
    }
    if let Some(window) = app.get_webview_window("capture") {
        let _ = window.hide();
    }
}

#[tauri::command]
pub(crate) fn confirm_screen_capture(
    app: AppHandle,
    captures: State<'_, ScreenCaptureStore>,
    selection: CaptureSelection,
) -> Result<ScreenshotPreview, String> {
    if selection.width < 8.0 || selection.height < 8.0 {
        return Err("请框选一个更大的截图区域".to_string());
    }
    let capture = app
        .get_webview_window("capture")
        .ok_or_else(|| "无法读取截图选择窗口".to_string())?;
    let origin = capture
        .outer_position()
        .map_err(|error| error.to_string())?;
    let scale = capture.scale_factor().map_err(|error| error.to_string())?;
    let (x, y, width, height) = capture_area_coordinates(origin, &selection, scale);
    let _ = capture.hide();
    thread::sleep(Duration::from_millis(140));

    let png = (|| {
        let screen = Monitor::from_point(x, y).map_err(|error| format!("无法读取屏幕：{error}"))?;
        let image = screen
            .capture_region(
                u32::try_from(x - screen.x().map_err(|error| error.to_string())?)
                    .map_err(|_| "截图横坐标超出屏幕")?,
                u32::try_from(y - screen.y().map_err(|error| error.to_string())?)
                    .map_err(|_| "截图纵坐标超出屏幕")?,
                width,
                height,
            )
            .map_err(|error| format!("截图失败，请检查屏幕录制权限：{error}"))?;
        let mut png = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut png, xcap::image::ImageFormat::Png)
            .map_err(|error| format!("无法生成截图预览：{error}"))?;
        Ok::<_, String>(png.into_inner())
    })();
    let png = match png {
        Ok(png) => png,
        Err(error) => {
            let _ = capture.show();
            let _ = capture.set_focus();
            return Err(error);
        }
    };
    let data_url = format!("data:image/png;base64,{}", BASE64_STANDARD.encode(png));
    let preview = ScreenshotPreview {
        data_url: data_url.clone(),
        width,
        height,
    };
    *captures
        .0
        .lock()
        .map_err(|_| "无法保存截图状态".to_string())? = Some(ScreenCapture {
        data_url,
        width,
        height,
    });
    let target = captures
        .1
        .lock()
        .map_err(|_| "无法读取截图来源")?
        .take()
        .unwrap_or_else(|| "bubble".into());
    if app.get_webview_window(&target).is_none() {
        return Err("截图来源窗口已关闭，请在当前会话重新截图".into());
    }
    show_and_focus(&app, &target);
    let _ = app.emit_to(target, "screenshot-ready", preview.clone());
    Ok(preview)
}

#[tauri::command]
pub(crate) fn get_screen_capture_preview(
    captures: State<'_, ScreenCaptureStore>,
) -> Result<Option<ScreenshotPreview>, String> {
    Ok(captures
        .0
        .lock()
        .map_err(|_| "无法读取截图状态".to_string())?
        .as_ref()
        .map(|capture| ScreenshotPreview {
            data_url: capture.data_url.clone(),
            width: capture.width,
            height: capture.height,
        }))
}

#[tauri::command]
pub(crate) fn clear_screen_capture(captures: State<'_, ScreenCaptureStore>) -> Result<(), String> {
    *captures
        .0
        .lock()
        .map_err(|_| "无法清除截图状态".to_string())? = None;
    Ok(())
}

#[tauri::command]
pub(crate) fn screen_capture_permission_status() -> String {
    #[cfg(target_os = "macos")]
    {
        let access = core_graphics::access::ScreenCaptureAccess;
        if access.preflight() {
            "已授权".to_string()
        } else {
            "截图时按需申请，首次使用请允许屏幕录制".to_string()
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        "截图时按需读取".to_string()
    }
}
