//! Text attachments and generated-text file operations.
use crate::runtime_types::PetVisualEvent;
use serde::Serialize;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::State;

pub(crate) const MAX_TEXT_ATTACHMENT_BYTES: u64 = 1024 * 1024;

pub(crate) const MAX_TEXT_ATTACHMENT_PREVIEW_CHARS: usize = 240;

#[derive(Clone, Debug)]
pub(crate) struct TextAttachment {
    pub(crate) display_name: String,
    pub(crate) content: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentPreview {
    pub(crate) display_name: String,
    pub(crate) byte_size: u64,
    pub(crate) char_count: usize,
    pub(crate) preview: String,
}

#[derive(Default)]
pub(crate) struct TextAttachmentStore(pub(crate) Mutex<Option<TextAttachment>>);

pub(crate) fn validate_save_path(path: &Path) -> Result<(), String> {
    const ALLOWED_EXTENSIONS: [&str; 12] = [
        "txt", "md", "json", "csv", "py", "js", "ts", "html", "css", "rs", "toml", "log",
    ];
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|extension| ALLOWED_EXTENSIONS.contains(&extension.as_str()))
        .ok_or_else(|| "不支持该文件类型".to_string())?;
    Ok(())
}

#[tauri::command]
pub(crate) fn save_generated_text(
    path: String,
    content: String,
    overwrite: bool,
) -> Result<(), String> {
    let path = PathBuf::from(path);
    validate_save_path(&path)?;
    if path.exists() && !overwrite {
        return Err("目标文件已存在，需要确认覆盖".to_string());
    }
    fs::write(path, content).map_err(|error| format!("保存文件失败：{error}"))
}

pub(crate) fn read_text_attachment(
    path: &Path,
) -> Result<(TextAttachment, AttachmentPreview), String> {
    const ALLOWED_EXTENSIONS: [&str; 5] = ["txt", "md", "json", "csv", "log"];

    let metadata = fs::metadata(path).map_err(|_| "无法读取该文件".to_string())?;
    if !metadata.is_file() {
        return Err("请拖入单个文本文件".to_string());
    }
    if metadata.len() > MAX_TEXT_ATTACHMENT_BYTES {
        return Err("文件过大，请选择不超过 1 MiB 的文本文件".to_string());
    }

    path.extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|extension| ALLOWED_EXTENSIONS.contains(&extension.as_str()))
        .ok_or_else(|| "仅支持 .txt、.md、.json、.csv 和 .log 文件".to_string())?;
    let display_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| "无法识别文件名".to_string())?
        .to_string();
    let content = fs::read_to_string(path).map_err(|_| "文件不是有效的 UTF-8 文本".to_string())?;
    let char_count = content.chars().count();
    let mut preview = content
        .chars()
        .take(MAX_TEXT_ATTACHMENT_PREVIEW_CHARS)
        .collect::<String>();
    if char_count > MAX_TEXT_ATTACHMENT_PREVIEW_CHARS {
        preview.push('…');
    }

    Ok((
        TextAttachment {
            display_name: display_name.clone(),
            content,
        },
        AttachmentPreview {
            display_name,
            byte_size: metadata.len(),
            char_count,
            preview,
        },
    ))
}

#[tauri::command]
pub(crate) fn prepare_text_attachment(
    app: AppHandle,
    attachments: State<'_, TextAttachmentStore>,
    path: String,
) -> Result<AttachmentPreview, String> {
    let (attachment, preview) = read_text_attachment(Path::new(&path))?;
    *attachments
        .0
        .lock()
        .map_err(|_| "无法保存附件状态".to_string())? = Some(attachment);
    let _ = app.emit_to("pet", "pet-visual-event", PetVisualEvent::AttachmentReady);
    Ok(preview)
}

#[tauri::command]
pub(crate) fn clear_text_attachment(
    attachments: State<'_, TextAttachmentStore>,
) -> Result<(), String> {
    *attachments
        .0
        .lock()
        .map_err(|_| "无法清除附件状态".to_string())? = None;
    Ok(())
}
