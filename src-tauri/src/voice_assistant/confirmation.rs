//! Only explicit, whole-utterance decisions approve the currently spoken draft.
pub(super) fn decision(text: &str) -> Option<bool> {
    let text: String = text
        .chars()
        .filter(|c| !c.is_whitespace() && !"，。！？、,.!?；;：:「」“”\"".contains(*c))
        .collect();
    match text.as_str() {
        "确认" | "确定" | "确认执行" | "确定执行" | "确认创建" | "同意" | "同意执行" | "可以"
        | "可以执行" | "好" | "好的" | "是" | "是的" | "没问题" | "执行" => {
            Some(true)
        }
        "取消" | "取消吧" | "取消操作" | "不" | "否" | "不是" | "不用" | "不用了" | "不要"
        | "不要了" | "不要执行" | "不执行" | "别执行" | "不确认" | "拒绝" | "算了" | "先别执行"
        | "先不要" | "不要创建" => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_explicit_decisions_but_never_substring_matches() {
        for text in ["确认。", "好的！", "同意执行", " 确认 执行 "] {
            assert_eq!(decision(text), Some(true), "{text}");
        }
        for text in ["取消", "不要执行！", "不确认", "不用了"] {
            assert_eq!(decision(text), Some(false), "{text}");
        }
        for text in [
            "",
            "我不确定",
            "不要确认",
            "好的，但是时间改一下",
            "确认取消",
            "确认。不执行",
            "明天再说",
            "。",
        ] {
            assert_eq!(decision(text), None, "{text}");
        }
    }
}
