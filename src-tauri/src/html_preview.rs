use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::Manager;

#[derive(Default)]
pub struct HtmlPreviewStore(Mutex<HashMap<String, PreviewFrame>>);
#[derive(Clone)]
struct PreviewFrame {
    html: String,
    network: bool,
}
static NEXT_FRAME: AtomicU64 = AtomicU64::new(1);
const OFFLINE_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
const ONLINE_CSP: &str = "default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; connect-src https:; frame-src 'none'; form-action 'none'; base-uri 'none'";

pub fn local_preview_navigation(url: &tauri::Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match url.scheme() {
        "tauri" | "preview" => url.host_str() == Some("localhost"),
        "about" => matches!(url.path(), "blank" | "srcdoc"),
        "http" | "https" => {
            matches!(
                url.host_str(),
                Some("tauri.localhost" | "preview.localhost")
            ) && url.port().is_none()
                || cfg!(debug_assertions)
                    && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
                    && url.port() == Some(1420)
        }
        _ => false,
    }
}

#[tauri::command]
pub fn create_html_preview_frame(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    source_chat_id: Option<String>,
    store: tauri::State<'_, HtmlPreviewStore>,
    html: String,
    allow_network: Option<bool>,
) -> Result<String, String> {
    let token=store.insert_with_policy(html, allow_network.unwrap_or(false))?;
    if let Some(source)=source_chat_id {
        if matches!(window.label(),"bubble"|"panel") {
            if let Some(db)=app.try_state::<std::sync::Arc<crate::memory::MemoryDb>>() {
                if let Ok(mut conn)=db.0.lock(){let _=crate::memory::soul::observations::register_preview(&mut conn,&token,window.label(),&source,crate::common::unix_timestamp() as i64);}
            }
        }
    }
    Ok(token)
}

#[tauri::command]
pub fn remove_html_preview_frame(
    store: tauri::State<'_, HtmlPreviewStore>,
    token: String,
) -> Result<(), String> {
    store.remove(&token)
}

/// Each detached window owns a separate snapshot so chat cleanup cannot blank it.
#[tauri::command]
pub async fn open_html_preview_window(
    app: tauri::AppHandle,
    html: String,
    source_chat_id: Option<String>,
    allow_network: Option<bool>,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<String, String> {
    let store = app.state::<HtmlPreviewStore>();
    let token = store.insert_with_policy(html, allow_network.unwrap_or(false))?;
    let label = format!("html-preview-{token}");
    let url = format!("index.html?view=html-preview&token={token}");
    let mut builder =
        tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url.into()))
            .on_navigation(local_preview_navigation)
            .title("Piko HTML Preview")
            .inner_size(1000.0, 720.0)
            .min_inner_size(360.0, 240.0)
            .resizable(true)
            .decorations(true);
    if let (Some(x), Some(y)) = (x, y) {
        if x.is_finite() && y.is_finite() {
            builder = builder.position(x, y);
        }
    }
    if let Some(source)=source_chat_id {
        if let Some(db)=app.try_state::<std::sync::Arc<crate::memory::MemoryDb>>() {
            if let Ok(mut conn)=db.0.lock(){let _=crate::memory::soul::observations::register_preview(&mut conn,&token,&label,&source,crate::common::unix_timestamp() as i64);}
        }
    }
    let window = match builder.build() {
        Ok(window) => window,
        Err(error) => {
            let _ = store.remove(&token);
            return Err(error.to_string());
        }
    };
    let cleanup_app = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let _ = cleanup_app.state::<HtmlPreviewStore>().remove(&token);
        }
    });
    let _ = window.set_focus();
    Ok(label)
}

pub fn response(app: &tauri::AppHandle, path: &str) -> tauri::http::Response<Vec<u8>> {
    let store = app.state::<HtmlPreviewStore>();
    response_from_store(&store, path)
}

impl HtmlPreviewStore {
    #[cfg(test)]
    fn insert(&self, html: String) -> Result<String, String> {
        self.insert_with_policy(html, false)
    }
    fn insert_with_policy(&self, html: String, network: bool) -> Result<String, String> {
        let token = format!(
            "{}-{}",
            std::process::id(),
            NEXT_FRAME.fetch_add(1, Ordering::Relaxed)
        );
        self.0
            .lock()
            .map_err(|_| "Preview store unavailable")?
            .insert(token.clone(), PreviewFrame { html, network });
        Ok(token)
    }

    fn remove(&self, token: &str) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "Preview store unavailable")?
            .remove(token);
        Ok(())
    }
}

fn response_from_store(store: &HtmlPreviewStore, path: &str) -> tauri::http::Response<Vec<u8>> {
    let html = path
        .strip_prefix("/frame/")
        .and_then(|token| store.0.lock().ok()?.get(token).cloned());
    let (status, body, network) = match html {
        Some(frame) => (200, frame.html, frame.network),
        None => (404, "Preview unavailable".to_owned(), false),
    };
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Cache-Control", "no-store")
        .header(
            "Content-Security-Policy",
            if network { ONLINE_CSP } else { OFFLINE_CSP },
        )
        .body(body.into_bytes())
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offline_frames_block_external_resources_and_navigation() {
        let store = HtmlPreviewStore::default();
        let offline = store
            .insert("<script>fetch('https://example.com')</script>".into())
            .unwrap();
        let response = response_from_store(&store, &format!("/frame/{offline}"));
        let policy = response.headers()["content-security-policy"]
            .to_str()
            .unwrap();
        assert!(policy.contains("connect-src 'none'") && !policy.contains("https:"));
        let online = store.insert_with_policy("online".into(), true).unwrap();
        assert!(
            response_from_store(&store, &format!("/frame/{online}")).headers()
                ["content-security-policy"]
                .to_str()
                .unwrap()
                .contains("connect-src https:")
        );
        for url in [
            "https://example.com/leak",
            "http://localhost:8500",
            "file:///etc/passwd",
            "data:text/html,test",
        ] {
            assert!(
                !local_preview_navigation(&tauri::Url::parse(url).unwrap()),
                "{url}"
            );
        }
        assert!(local_preview_navigation(
            &tauri::Url::parse("preview://localhost/frame/1").unwrap()
        ));
    }

    #[test]
    fn serves_html_with_scripts_and_utf8_then_removes_it() {
        let store = HtmlPreviewStore::default();
        let html = "<!doctype html><h1>预览正常</h1><script>document.title='ready'</script>";
        let token = store.insert(html.to_owned()).unwrap();
        let path = format!("/frame/{token}");
        let response = response_from_store(&store, &path);
        assert_eq!(response.status(), 200);
        assert_eq!(response.body(), html.as_bytes());
        assert_eq!(
            response.headers()["content-type"],
            "text/html; charset=utf-8"
        );
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert!(response.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("script-src 'unsafe-inline'"));
        store.remove(&token).unwrap();
        assert_eq!(response_from_store(&store, &path).status(), 404);
        store.remove(&token).unwrap();
    }

    #[test]
    fn unique_frames_are_isolated_and_unknown_paths_return_404() {
        let store = HtmlPreviewStore::default();
        let first = store.insert("first".into()).unwrap();
        let second = store.insert("second".into()).unwrap();
        assert_ne!(first, second);
        store.remove(&first).unwrap();
        assert_eq!(
            response_from_store(&store, &format!("/frame/{second}")).body(),
            b"second"
        );
        for path in ["/", "/frame/missing", "/other/frame", "/frame/../frame"] {
            assert_eq!(response_from_store(&store, path).status(), 404);
        }
    }
}
