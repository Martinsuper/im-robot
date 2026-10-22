use super::{service::*, Memo, MemoInput, MemoSummaryGroup};
use crate::storage;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter};

#[tauri::command]
pub(crate) fn list_memos(app: AppHandle) -> Vec<Memo> {
    let mut memos = read_memos(&app);
    memos.sort_by_key(|memo| std::cmp::Reverse(memo.updated_at));
    memos
}

#[tauri::command]
pub(crate) fn create_memo(app: AppHandle, input: MemoInput) -> Result<Memo, String> {
    create_memo_record(&app, input)
}

#[tauri::command]
pub(crate) fn update_memo(app: AppHandle, id: String, input: MemoInput) -> Result<Memo, String> {
    let _transaction = storage::transaction();
    let mut memos = read_memos(&app);
    let index = memos
        .iter()
        .position(|memo| memo.id == id)
        .ok_or_else(|| "未找到该备忘录".to_string())?;
    let created_at = memos[index].created_at;
    let memo = memo_from_input(id, input, created_at)?;
    memos[index] = memo.clone();
    persist_memos(&app, &memos)?;
    let _ = app.emit("memos-updated", ());
    Ok(memo)
}

#[tauri::command]
pub(crate) fn delete_memo(app: AppHandle, id: String) -> Result<(), String> {
    let _transaction = storage::transaction();
    let mut memos = read_memos(&app);
    let previous_len = memos.len();
    memos.retain(|memo| memo.id != id);
    if memos.len() == previous_len {
        return Err("未找到该备忘录".to_string());
    }
    persist_memos(&app, &memos)?;
    let _ = app.emit("memos-updated", ());
    Ok(())
}

#[tauri::command]
pub(crate) fn summarize_memos(app: AppHandle) -> Vec<MemoSummaryGroup> {
    let memos = read_memos(&app);
    let order = [
        "task",
        "idea",
        "learning",
        "work",
        "life",
        "reference",
        "other",
    ];
    let mut groups = Vec::new();

    for category in order {
        let items = memos
            .iter()
            .filter(|memo| memo.category == category)
            .collect::<Vec<_>>();
        if items.is_empty() {
            continue;
        }

        let mut tag_counts: HashMap<String, usize> = HashMap::new();
        for memo in &items {
            for tag in &memo.tags {
                *tag_counts.entry(tag.clone()).or_default() += 1;
            }
        }
        let mut top_tags = tag_counts.into_iter().collect::<Vec<_>>();
        top_tags.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));

        let latest_updated_at = items
            .iter()
            .map(|memo| memo.updated_at)
            .max()
            .unwrap_or_default();
        let sample_titles = items
            .iter()
            .take(3)
            .map(|memo| memo.title.as_str())
            .collect::<Vec<_>>()
            .join("、");

        groups.push(MemoSummaryGroup {
            category: category.to_string(),
            count: items.len(),
            latest_updated_at,
            summary: format!(
                "{}类备忘共 {} 条：{}",
                memo_category_label(category),
                items.len(),
                sample_titles
            ),
            top_tags: top_tags.into_iter().take(4).map(|(tag, _)| tag).collect(),
        });
    }

    groups
}
