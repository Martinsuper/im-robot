use super::{memo_from_input, MemoInput};

#[test]
fn memo_category_prefers_explicit_input_and_preserves_it_in_result() {
    let memo = memo_from_input(
        "memo-explicit".to_string(),
        MemoInput {
            title: "随手记".to_string(),
            content: "整理阅读资料".to_string(),
            category: Some("reference".to_string()),
        },
        100,
    )
    .expect("memo should be created");

    assert_eq!(memo.category, "reference");
    assert_eq!(memo.tags[0], "资料");
}
#[test]
fn memo_category_falls_back_to_inference_when_not_selected() {
    let memo = memo_from_input(
        "memo-inferred".to_string(),
        MemoInput {
            title: "修复发布问题".to_string(),
            content: "检查并提交代码".to_string(),
            category: None,
        },
        100,
    )
    .expect("memo should be created");

    assert_eq!(memo.category, "task");
}
