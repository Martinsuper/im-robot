//! 屏幕截图：macOS 屏幕录制权限、区域坐标换算、PNG 编码与预览状态存取。

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use screenshots::{image::DynamicImage, Screen};
use serde::{Deserialize, Serialize};
use std::{io::Cursor, sync::Mutex, thread, time::Duration};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State};

use crate::show_and_focus;

#[derive(Clone, Debug)]
pub struct ScreenCapture {
    pub data_url: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSelection {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotPreview {
    data_url: String,
    width: u32,
    height: u32,
}

#[derive(Default)]
pub struct ScreenCaptureStore(pub Mutex<Option<ScreenCapture>>);

pub fn parse_data_url(data_url: &str) -> Result<(&str, &str), String> {
    let encoded = data_url
        .strip_prefix("data:")
        .and_then(|value| value.split_once(";base64,"))
        .ok_or_else(|| "截图数据格式无效".to_string())?;
    Ok(encoded)
}

#[cfg(target_os = "macos")]
fn ensure_screen_capture_permission() -> Result<(), String> {
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
fn ensure_screen_capture_permission() -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn capture_area_coordinates(
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
pub fn capture_area_coordinates(
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
pub fn begin_screen_capture(app: AppHandle) -> Result<(), String> {
    ensure_screen_capture_permission()?;
    let capture = app
        .get_webview_window("capture")
        .ok_or_else(|| "无法打开截图选择窗口".to_string())?;
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
    capture.show().map_err(|error| error.to_string())?;
    capture.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn cancel_screen_capture(app: AppHandle) {
    if let Some(window) = app.get_webview_window("capture") {
        let _ = window.hide();
    }
}

#[tauri::command]
pub fn confirm_screen_capture(
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
        let screen = Screen::from_point(x, y).map_err(|error| format!("无法读取屏幕：{error}"))?;
        let image = screen
            .capture_area(
                x - screen.display_info.x,
                y - screen.display_info.y,
                width,
                height,
            )
            .map_err(|error| format!("截图失败，请检查屏幕录制权限：{error}"))?;
        let mut png = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut png, screenshots::image::ImageOutputFormat::Png)
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
    show_and_focus(&app, "bubble");
    let _ = app.emit_to("bubble", "screenshot-ready", preview.clone());
    Ok(preview)
}

#[tauri::command]
pub fn get_screen_capture_preview(
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
pub fn clear_screen_capture(captures: State<'_, ScreenCaptureStore>) -> Result<(), String> {
    *captures
        .0
        .lock()
        .map_err(|_| "无法清除截图状态".to_string())? = None;
    Ok(())
}

#[tauri::command]
pub fn screen_capture_permission_status() -> String {
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
