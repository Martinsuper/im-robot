use chrono::{Datelike, Days, Local, TimeZone, Weekday};

pub(crate) fn next_repeat_due(due_at: u64, repeat: &str, now: u64) -> u64 {
    next_in_timezone(due_at, repeat, now, &Local)
}

fn next_in_timezone<T: TimeZone>(due_at: u64, repeat: &str, now: u64, timezone: &T) -> u64 {
    let Some(original) = timezone.timestamp_opt(due_at as i64, 0).single() else {
        return now.saturating_add(86_400);
    };
    let step = if repeat == "weekly" { 7 } else { 1 };
    let mut date = original.date_naive();
    loop {
        date = date
            .checked_add_days(Days::new(step))
            .expect("valid reminder date");
        if repeat == "weekdays" && matches!(date.weekday(), Weekday::Sat | Weekday::Sun) {
            continue;
        }
        let local = date.and_time(original.time());
        // Pick the earlier occurrence on a repeated DST hour. For a missing hour,
        // advance to the first valid local minute rather than shifting future days.
        for minute in 0..=180 {
            if let Some(next) = timezone
                .from_local_datetime(&(local + chrono::Duration::minutes(minute)))
                .earliest()
            {
                if next.timestamp() as u64 > now {
                    return next.timestamp() as u64;
                }
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;
    #[test]
    fn friday_morning_in_shanghai_skips_the_weekend() {
        let tz = FixedOffset::east_opt(8 * 3600).unwrap();
        let friday = tz
            .with_ymd_and_hms(2026, 9, 25, 7, 0, 0)
            .unwrap()
            .timestamp() as u64;
        let monday = tz
            .with_ymd_and_hms(2026, 9, 28, 7, 0, 0)
            .unwrap()
            .timestamp() as u64;
        assert_eq!(next_in_timezone(friday, "weekdays", friday, &tz), monday);
    }
    #[test]
    fn catches_up_without_changing_wall_clock_time() {
        let tz = FixedOffset::west_opt(7 * 3600).unwrap();
        let start = tz
            .with_ymd_and_hms(2026, 9, 21, 23, 30, 0)
            .unwrap()
            .timestamp() as u64;
        let now = tz
            .with_ymd_and_hms(2026, 9, 24, 10, 0, 0)
            .unwrap()
            .timestamp() as u64;
        let expected = tz
            .with_ymd_and_hms(2026, 9, 24, 23, 30, 0)
            .unwrap()
            .timestamp() as u64;
        assert_eq!(next_in_timezone(start, "daily", now, &tz), expected);
    }
}
