//! Local notification identity is the ledger message ID. No permission prompts.
use super::model::*;
use std::{
    ffi::{c_char, CStr, CString},
    sync::OnceLock,
};
use tauri::{AppHandle, Manager};
static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn log_gate(reason: &str) {
    #[cfg(all(target_os = "macos", debug_assertions))]
    {
        extern "C" { fn piko_soul_log_gate(reason: *const c_char); }
        if let Ok(reason) = CString::new(reason) {
            unsafe { piko_soul_log_gate(reason.as_ptr()); }
        }
    }
    #[cfg(not(all(target_os = "macos", debug_assertions)))]
    let _ = reason;
}
#[cfg(target_os = "macos")]
extern "C" {
    fn piko_soul_notifications_init(
        open: extern "C" fn(*const c_char),
        allowed: extern "C" fn(*const c_char) -> bool,
    );
    fn piko_soul_notify(id: *const c_char, title: *const c_char, body: *const c_char);
    fn piko_soul_remove_notifications(active_json: *const c_char);
}

extern "C" fn allowed(id: *const c_char) -> bool {
    if id.is_null() {
        return false;
    }
    let Ok(id) = unsafe { CStr::from_ptr(id) }.to_str() else {
        return false;
    };
    let Some(app) = APP.get() else { return false };
    let db = app.state::<std::sync::Arc<crate::memory::MemoryDb>>();
    let Ok(conn) = db.0.lock() else { return false };
    conn.query_row("SELECT EXISTS(SELECT 1 FROM soul_proactive_ledger l,soul_control c WHERE l.id=?1 AND l.state IN ('dispatching','shown') AND c.enabled=1 AND c.paused=0)",[id],|r|r.get::<_,bool>(0)).unwrap_or(false)
}
extern "C" fn open(id: *const c_char) {
    if !allowed(id) {
        return;
    }
    let Some(app) = APP.get() else { return };
    let Ok(id) = unsafe { CStr::from_ptr(id) }.to_str() else {
        return;
    };
    if let Some(window) = app.get_webview_window("bubble") {
        let _ = window.show();
        let _ = window.set_focus();
        super::commands::open_notification(app, id);
    }
}

pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    // UNUserNotificationCenter requires a bundled application. Unit-test hosts
    // intentionally never initialize it.
    #[cfg(target_os = "macos")]
    unsafe {
        piko_soul_notifications_init(open, allowed);
    }
}

pub fn notify(message: &ProactiveMessage, text: &str) {
    if message.category != ProactiveCategory::TaskUnresolved {
        return;
    }
    #[cfg(target_os = "macos")]
    if let (Ok(id), Ok(title), Ok(body)) = (
        CString::new(message.id.as_str()),
        CString::new("Piko"),
        CString::new(text),
    ) {
        unsafe {
            piko_soul_notify(id.as_ptr(), title.as_ptr(), body.as_ptr());
        }
    }
    // Other platforms stay bubble-only until their permission/click adapters
    // can preserve this same identity. The generic plugin drops this metadata.
}
pub fn reconcile(ids: &[String]) {
    #[cfg(target_os = "macos")]
    if let Ok(json) = CString::new(serde_json::to_string(ids).unwrap_or_default()) {
        unsafe {
            piko_soul_remove_notifications(json.as_ptr());
        }
    }
}

#[cfg(target_os = "macos")]
static PERMISSION_REQUEST: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<bool>>> = std::sync::Mutex::new(None);
#[cfg(target_os = "macos")]
extern "C" fn permission_result(granted:bool){
    if let Ok(mut pending)=PERMISSION_REQUEST.lock(){if let Some(sender)=pending.take(){let _=sender.send(granted);}}
}
/// Permission is requested only following a user's explicit settings action.
pub async fn request_permission()->Result<bool,String>{
    #[cfg(target_os="macos")]
    {
        extern "C" {fn piko_soul_request_notification_permission(completion:extern "C" fn(bool));}
        let(sender,receiver)=tokio::sync::oneshot::channel();
        {let mut pending=PERMISSION_REQUEST.lock().map_err(|_|"permission_unavailable")?;
         if pending.is_some(){return Err("permission_request_pending".into());}*pending=Some(sender);}
        unsafe{piko_soul_request_notification_permission(permission_result);}
        receiver.await.map_err(|_|"permission_unavailable".into())
    }
    #[cfg(not(target_os="macos"))]
    {Ok(false)}
}
