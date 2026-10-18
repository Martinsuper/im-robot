use super::CalendarEvent;
use chrono::{Local, TimeZone};
use std::path::Path;

pub(crate) fn escape_icalendar_text(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace('\n', "\\n")
}

pub(crate) fn render_icalendar(events: &[CalendarEvent]) -> Result<String, String> {
    let mut lines = vec![
        "BEGIN:VCALENDAR".to_string(),
        "VERSION:2.0".to_string(),
        "PRODID:-//Piko//Local Calendar//EN".to_string(),
        "CALSCALE:GREGORIAN".to_string(),
    ];
    for event in events {
        let start = Local
            .timestamp_opt(event.start_at as i64, 0)
            .single()
            .ok_or_else(|| "日程开始时间无效".to_string())?
            .with_timezone(&chrono::Utc)
            .format("%Y%m%dT%H%M%SZ")
            .to_string();
        let end = Local
            .timestamp_opt(event.end_at as i64, 0)
            .single()
            .ok_or_else(|| "日程结束时间无效".to_string())?
            .with_timezone(&chrono::Utc)
            .format("%Y%m%dT%H%M%SZ")
            .to_string();
        lines.extend([
            "BEGIN:VEVENT".to_string(),
            format!("UID:{}@piko.local", escape_icalendar_text(&event.id)),
            format!("DTSTAMP:{}", chrono::Utc::now().format("%Y%m%dT%H%M%SZ")),
            format!("DTSTART:{start}"),
            format!("DTEND:{end}"),
            format!("SUMMARY:{}", escape_icalendar_text(&event.title)),
        ]);
        if let Some(location) = &event.location {
            lines.push(format!("LOCATION:{}", escape_icalendar_text(location)));
        }
        if let Some(notes) = &event.notes {
            lines.push(format!("DESCRIPTION:{}", escape_icalendar_text(notes)));
        }
        lines.push("END:VEVENT".to_string());
    }
    lines.push("END:VCALENDAR".to_string());
    Ok(format!("{}\r\n", lines.join("\r\n")))
}

pub(crate) fn validate_icalendar_path(path: &Path) -> Result<(), String> {
    if path.extension().and_then(|extension| extension.to_str()) == Some("ics") {
        Ok(())
    } else {
        Err("日程导出文件必须使用 .ics 扩展名".to_string())
    }
}
