//! The same batch-selection validation is used by authorization and final execution.
use serde_json::Value;
use std::collections::HashSet;

pub(crate) fn selected_calendar_batch_events(
    events: &Value,
    indexes: Option<Vec<usize>>,
) -> Result<Value, String> {
    let events = events.as_array().ok_or("批量日程参数无效")?;
    let indexes = indexes.unwrap_or_else(|| (0..events.len()).collect());
    if indexes.is_empty() {
        return Err("请至少选择一条日程".to_string());
    }
    let mut selected = Vec::with_capacity(indexes.len());
    let mut seen = HashSet::new();
    for index in indexes {
        if !seen.insert(index) {
            return Err("批量日程选择项重复".to_string());
        }
        selected.push(events.get(index).cloned().ok_or("批量日程选择项无效")?);
    }
    Ok(Value::Array(selected))
}
