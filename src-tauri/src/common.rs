//! Shared value parsing, text limits and timestamps.
use chrono::DateTime;
use chrono::Local;
use chrono::NaiveDateTime;
use chrono::TimeZone;
use serde_json::Value;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

pub(crate) fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub(crate) fn tool_timestamp(value: &Value) -> Result<u64, String> {
    if let Some(timestamp) = value.as_u64() {
        return Ok(timestamp);
    }

    let raw = value
        .as_str()
        .ok_or_else(|| "时间必须是 ISO 8601 字符串".to_string())?;
    if let Ok(parsed) = DateTime::parse_from_rfc3339(raw) {
        return u64::try_from(parsed.timestamp()).map_err(|_| "时间不能早于 1970 年".to_string());
    }

    let parsed = NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S"))
        .or_else(|_| NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M"))
        .or_else(|_| NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M"))
        .map_err(|_| "时间必须是 ISO 8601 格式".to_string())?;
    let parsed = Local
        .from_local_datetime(&parsed)
        .single()
        .ok_or_else(|| "本地时间无效，请提供带时区的 ISO 8601 时间".to_string())?;
    u64::try_from(parsed.timestamp()).map_err(|_| "时间不能早于 1970 年".to_string())
}

pub(crate) fn tool_timestamp_str(value: &str) -> Option<u64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date_time| date_time.timestamp().max(0) as u64)
}

pub(crate) fn parse_data_url(data_url: &str) -> Result<(&str, &str), String> {
    let encoded = data_url
        .strip_prefix("data:")
        .and_then(|value| value.split_once(";base64,"))
        .ok_or_else(|| "截图数据格式无效".to_string())?;
    Ok(encoded)
}

pub(crate) fn truncate_text(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}
