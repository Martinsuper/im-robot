//! System notifications with native macOS authorization and observable delivery errors.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;
#[cfg(not(target_os = "macos"))]
use tauri_plugin_notification::NotificationExt;

static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

/// 委托任务通知（04 §4.7）：同任务同级别 5 分钟内不重复。
const TASK_NOTIFY_TTL: Duration = Duration::from_secs(5 * 60);
static TASK_THROTTLE: LazyLock<Mutex<HashMap<String, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn should_task_notify_at(map: &mut HashMap<String, Instant>, key: &str, now: Instant) -> bool {
    if map.len() > 256 {
        map.retain(|_, at| now.duration_since(*at) < TASK_NOTIFY_TTL);
    }
    match map.get(key) {
        Some(at) if now.duration_since(*at) < TASK_NOTIFY_TTL => false,
        _ => {
            map.insert(key.to_string(), now);
            true
        }
    }
}

/// 任务状态迁移通知：等待确认与终态触达（respect quiet_mode = minimal）。
pub(crate) fn task_event(app: &AppHandle, request_id: &str, level: &str, title: &str, body: &str) {
    if crate::settings::read_settings(app).quiet_mode == "minimal" {
        return;
    }
    let allowed = match TASK_THROTTLE.lock() {
        Ok(mut map) => {
            should_task_notify_at(&mut map, &format!("{request_id}:{level}"), Instant::now())
        }
        Err(_) => false,
    };
    if !allowed {
        return;
    }
    let app = app.clone();
    let title = title.to_string();
    let body = body.to_string();
    // 原生通知桥会阻塞等待系统回调；交给监督线程，避免拖慢任务事件循环。
    crate::background::SUPERVISOR.spawn_effect("agent-notify", move |_| {
        let _ = send(&app, &title, &body);
    });
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NotificationStatus {
    platform: String,
    authorization: String,
    alerts_enabled: Option<bool>,
    sounds_enabled: Option<bool>,
    alert_style: Option<String>,
    #[serde(default)]
    last_error: Option<String>,
}

#[cfg(target_os = "macos")]
mod native {
    use serde_json::Value;
    use std::{
        ffi::{c_char, CStr, CString},
        sync::mpsc,
        time::Duration,
    };
    type Sender = mpsc::SyncSender<Result<Value, String>>;
    type Completion = extern "C" fn(*const c_char, usize);
    extern "C" {
        fn piko_system_notification_status(done: Completion, context: usize);
        fn piko_system_notify(
            id: *const c_char,
            title: *const c_char,
            body: *const c_char,
            done: Completion,
            context: usize,
        );
    }
    extern "C" fn complete(json: *const c_char, context: usize) {
        // The native bridge calls this exactly once, including exception paths.
        let sender = unsafe { Box::from_raw(context as *mut Sender) };
        let result = if json.is_null() {
            Err("无法读取系统通知响应".into())
        } else {
            unsafe { CStr::from_ptr(json) }
                .to_str()
                .map_err(|_| "无效的系统通知响应".into())
                .and_then(|text| {
                    serde_json::from_str(text).map_err(|_| "无效的系统通知响应".into())
                })
                .and_then(|value: Value| {
                    if value["ok"].as_bool() == Some(true) {
                        Ok(value)
                    } else {
                        Err(value["error"]
                            .as_str()
                            .unwrap_or("系统通知发送失败")
                            .to_string())
                    }
                })
        };
        let _ = sender.send(result);
    }
    fn request(start: impl FnOnce(Completion, usize)) -> Result<Value, String> {
        let (sender, receiver) = mpsc::sync_channel(1);
        start(complete, Box::into_raw(Box::new(sender)) as usize);
        receiver
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "系统通知服务响应超时".to_string())?
    }
    pub(super) fn status() -> Result<super::NotificationStatus, String> {
        let value =
            request(|done, context| unsafe { piko_system_notification_status(done, context) })?;
        serde_json::from_value(value).map_err(|_| "无效的系统通知权限状态".into())
    }
    pub(super) fn send(title: &str, body: &str) -> Result<(), String> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let id = CString::new(format!(
            "piko-system:{}:{}",
            crate::common::unix_timestamp(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
        .unwrap();
        let title = CString::new(title).map_err(|_| "通知标题包含无效字符")?;
        let body = CString::new(body).map_err(|_| "通知内容包含无效字符")?;
        request(|done, context| unsafe {
            piko_system_notify(id.as_ptr(), title.as_ptr(), body.as_ptr(), done, context)
        })
        .map(|_| ())
    }
}

pub(crate) fn send(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let result = {
        let _ = app;
        native::send(title, body)
    };
    #[cfg(not(target_os = "macos"))]
    let result = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| error.to_string());
    if let Ok(mut error) = LAST_ERROR.lock() {
        *error = result.as_ref().err().cloned();
    }
    if let Err(error) = &result {
        eprintln!("[notifications] {error}");
    }
    result
}

#[tauri::command]
pub(crate) async fn get_notification_status(app: AppHandle) -> Result<NotificationStatus, String> {
    let mut status = tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            let _ = app;
            native::status()
        }
        #[cfg(not(target_os = "macos"))]
        {
            app.notification()
                .permission_state()
                .map(|permission| NotificationStatus {
                    platform: std::env::consts::OS.into(),
                    authorization: format!("{permission:?}").to_lowercase(),
                    alerts_enabled: None,
                    sounds_enabled: None,
                    alert_style: None,
                    last_error: None,
                })
                .map_err(|error| error.to_string())
        }
    })
    .await
    .map_err(|_| "通知状态查询失败".to_string())??;
    status.last_error = LAST_ERROR.lock().ok().and_then(|error| error.clone());
    Ok(status)
}

#[tauri::command]
pub(crate) async fn request_notification_permission(
    app: AppHandle,
) -> Result<NotificationStatus, String> {
    #[cfg(target_os = "macos")]
    {
        crate::memory::soul::notifications::request_permission().await?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        app.notification()
            .request_permission()
            .map_err(|error| error.to_string())?;
    }
    get_notification_status(app).await
}

#[tauri::command]
pub(crate) async fn send_test_notification(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        send(
            &app,
            "Piko 测试通知",
            "看到这条消息，说明 Piko 的系统通知已送达。",
        )
    })
    .await
    .map_err(|_| "测试通知发送失败".to_string())?
}

#[tauri::command]
pub(crate) fn open_notification_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.Notifications-Settings.extension")
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", "ms-settings:notifications"])
            .spawn()
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("请在系统设置中打开通知设置".into())
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::native;
    #[test]
    fn native_status_preserves_denial_and_banner_settings() {
        let status: super::NotificationStatus = serde_json::from_str(r#"{"platform":"macos","authorization":"denied","alertsEnabled":false,"soundsEnabled":false,"alertStyle":"none"}"#).unwrap();
        assert_eq!(status.authorization, "denied");
        assert_eq!(status.alerts_enabled, Some(false));
        assert_eq!(status.alert_style.as_deref(), Some("none"));
    }
    #[test]
    fn invalid_notification_text_never_reaches_the_native_api() {
        assert!(native::send("invalid\0title", "body").is_err());
        assert!(native::send("title", "invalid\0body").is_err());
    }
}

#[cfg(test)]
mod throttle_tests {
    use super::*;
    #[test]
    fn same_task_level_is_throttled_within_ttl_only() {
        let mut map = HashMap::new();
        let now = Instant::now();
        assert!(should_task_notify_at(&mut map, "r1:confirm", now));
        assert!(!should_task_notify_at(
            &mut map,
            "r1:confirm",
            now + TASK_NOTIFY_TTL - Duration::from_millis(1)
        ));
        assert!(should_task_notify_at(
            &mut map,
            "r1:confirm",
            now + TASK_NOTIFY_TTL
        ));
        // 不同任务或不同级别互不影响。
        assert!(should_task_notify_at(&mut map, "r1:done", now));
        assert!(should_task_notify_at(&mut map, "r2:confirm", now));
    }
}
