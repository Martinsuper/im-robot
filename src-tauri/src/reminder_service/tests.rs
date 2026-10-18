use super::{scheduler::collect_due_reminders, Reminder};

#[test]
fn triggers_only_due_pending_reminders_once() {
    let mut reminders = vec![
        Reminder {
            id: "due".to_string(),
            title: "到期".to_string(),
            due_at: 9,
            status: "pending".to_string(),
            repeat: "none".to_string(),
        },
        Reminder {
            id: "future".to_string(),
            title: "稍后".to_string(),
            due_at: 11,
            status: "pending".to_string(),
            repeat: "none".to_string(),
        },
        Reminder {
            id: "done".to_string(),
            title: "完成".to_string(),
            due_at: 8,
            status: "triggered".to_string(),
            repeat: "none".to_string(),
        },
    ];

    let due = collect_due_reminders(&mut reminders, 10);
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].id, "due");
    assert_eq!(reminders[0].status, "triggered");
    assert!(collect_due_reminders(&mut reminders, 10).is_empty());
}
#[test]
fn reschedules_repeating_reminders_after_triggering() {
    let mut reminders = vec![Reminder {
        id: "daily".to_string(),
        title: "每日提醒".to_string(),
        due_at: 9,
        status: "pending".to_string(),
        repeat: "daily".to_string(),
    }];

    let due = collect_due_reminders(&mut reminders, 10);
    assert_eq!(due.len(), 1);
    assert_eq!(reminders[0].status, "pending");
    assert!(reminders[0].due_at > 10);
    assert!(collect_due_reminders(&mut reminders, 10).is_empty());
}
