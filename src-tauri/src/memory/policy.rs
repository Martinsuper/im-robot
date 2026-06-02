use super::model::CreateMemoryInput;

pub fn validate_create_input(input: &CreateMemoryInput) -> Result<(), String> {
    if input.title.trim().is_empty() {
        return Err("记忆标题不能为空".to_string());
    }
    if input.title.chars().count() > 200 {
        return Err("记忆标题不能超过 200 个字符".to_string());
    }
    if input.content.len() > 50_000 {
        return Err("记忆内容过长，超过 50KB 限制".to_string());
    }
    if input.importance > 10 {
        return Err("重要度必须在 0-10 之间".to_string());
    }
    Ok(())
}

/// Check if content contains sensitive patterns that should not be stored.
/// Phase 1: simple keyword-based filter.
pub fn contains_sensitive_content(content: &str) -> bool {
    let lower = content.to_lowercase();
    let sensitive_keywords = [
        "api_key",
        "apikey",
        "api-key",
        "password",
        "密码",
        "secret_key",
        "secretkey",
        "private_key",
        "privatekey",
        "token",
        "令牌",
    ];
    sensitive_keywords.iter().any(|kw| lower.contains(*kw))
}
