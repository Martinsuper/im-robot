//! HTML favorites, persistence and output lifecycle updates.
use crate::common::truncate_text;
use crate::common::unix_timestamp;
use crate::memory;
use crate::storage;
use chrono::Local;
use serde::Deserialize;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HtmlFavorite {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) html: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) source_chat_id: Option<String>,
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HtmlFavoriteInput {
    pub(crate) html: String,
    #[serde(default)]
    pub(crate) source_chat_id: Option<String>,
}

pub(crate) fn html_favorites_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("html-favorites.json"))
}

pub(crate) fn read_html_favorites(app: &AppHandle) -> Vec<HtmlFavorite> {
    html_favorites_path(app)
        .map(|path| storage::read_or_default(&path))
        .unwrap_or_default()
}

pub(crate) fn persist_html_favorites(
    app: &AppHandle,
    favorites: &[HtmlFavorite],
) -> Result<(), String> {
    let path = html_favorites_path(app).ok_or("无法获取数据路径")?;
    storage::write(&path, favorites)
}

pub(crate) fn html_favorite_id() -> String {
    format!(
        "htmlfav-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

pub(crate) fn html_favorite_title(html: &str) -> String {
    let mut text = String::new();
    let mut in_tag = false;
    for character in html.chars() {
        if character == '<' {
            in_tag = true;
            if !text.ends_with(' ') {
                text.push(' ');
            }
            continue;
        }
        if character == '>' {
            in_tag = false;
            continue;
        }
        if !in_tag {
            text.push(character);
        }
    }
    let first_line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let title = truncate_text(&first_line, 30);
    if title.trim().is_empty() {
        let now = Local::now();
        format!("HTML 收藏 {}", now.format("%m-%d %H:%M"))
    } else {
        title
    }
}

#[tauri::command]
pub(crate) fn list_html_favorites(app: AppHandle) -> Vec<HtmlFavorite> {
    let mut favorites = read_html_favorites(&app);
    favorites.sort_by_key(|favorite| std::cmp::Reverse(favorite.updated_at));
    favorites
}

#[tauri::command]
pub(crate) fn create_html_favorite(
    app: AppHandle,
    input: HtmlFavoriteInput,
) -> Result<HtmlFavorite, String> {
    let _transaction = storage::transaction();
    let html = input.html.trim();
    if html.is_empty() {
        return Err("收藏内容不能为空".to_string());
    }
    if html.len() > 200 * 1024 {
        return Err("收藏内容过大".to_string());
    }
    let mut favorites = read_html_favorites(&app);
    if let Some(existing) = favorites.iter().find(|item| item.html.trim() == html) {
        return Ok(existing.clone());
    }
    let now = unix_timestamp();
    let favorite = HtmlFavorite {
        id: html_favorite_id(),
        title: html_favorite_title(html),
        html: html.to_string(),
        source_chat_id: input.source_chat_id,
        created_at: now,
        updated_at: now,
    };
    favorites.push(favorite.clone());
    persist_html_favorites(&app, &favorites)?;
    if let Some(db) = app.try_state::<Arc<memory::MemoryDb>>() {
        if let Ok(mut conn) = db.0.lock() {
            let source = memory::soul::model::SourceRef {
                kind: "chat_session".into(),
                id: favorite
                    .source_chat_id
                    .clone()
                    .unwrap_or_else(|| favorite.id.clone()),
                revision: 1,
            };
            let _ = memory::soul::observations::emit_output(
                &mut conn,
                &favorite.id,
                &source,
                "favorited",
                now as i64,
                now as i64,
            );
            let _ = memory::soul::continuity::record_event(
                &mut conn,
                "favorite_saved",
                &source,
                now as i64,
                now as i64,
            );
        }
    }

    let _ = app.emit_to("panel", "html-favorites-updated", ());
    let _ = app.emit_to("bubble", "html-favorites-updated", ());
    Ok(favorite)
}

#[tauri::command]
pub(crate) fn delete_html_favorite(app: AppHandle, id: String) -> Result<(), String> {
    let _transaction = storage::transaction();
    let mut favorites = read_html_favorites(&app);
    let previous_len = favorites.len();
    favorites.retain(|favorite| favorite.id != id);
    if favorites.len() == previous_len {
        return Err("未找到该收藏".to_string());
    }
    persist_html_favorites(&app, &favorites)?;
    if let Some(db) = app.try_state::<Arc<memory::MemoryDb>>() {
        if let Ok(mut conn) = db.0.lock() {
            let _ = memory::soul::store::transaction(&mut conn, |tx| {
                tx.execute("UPDATE soul_proactive_ledger SET state='revoked',receipt_at=?2 WHERE id=?1 AND state IN ('pending','dispatching','shown')",rusqlite::params![format!("output-{id}"),unix_timestamp() as i64]).map_err(|_|"ledger_write_failed")?;
                Ok(())
            });
        }
        memory::soul::commands::reconcile_visible(&app);
    }

    let _ = app.emit_to("panel", "html-favorites-updated", ());
    let _ = app.emit_to("bubble", "html-favorites-updated", ());
    Ok(())
}
