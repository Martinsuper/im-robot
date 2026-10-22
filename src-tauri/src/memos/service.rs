use super::{Memo, MemoInput, MEMO_CATEGORIES};
use crate::agent_operations;
use crate::common::truncate_text;
use crate::common::unix_timestamp;
use crate::storage;
use serde_json::Value;
use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

pub(crate) fn memos_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("memos.json"))
}

pub(crate) fn read_memos(app: &AppHandle) -> Vec<Memo> {
    memos_path(app)
        .map(|path| storage::read_or_default(&path))
        .unwrap_or_default()
}

pub(crate) fn persist_memos(app: &AppHandle, memos: &[Memo]) -> Result<(), String> {
    let path = memos_path(app).ok_or("无法获取数据路径")?;
    storage::write(&path, memos)
}

pub(crate) fn memo_id() -> String {
    format!(
        "memo-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}

pub(crate) fn memo_input_from_value(value: &Value) -> Result<MemoInput, String> {
    let title = value["title"]
        .as_str()
        .ok_or_else(|| "备忘录标题不能为空".to_string())?
        .to_string();
    let content = value["content"]
        .as_str()
        .ok_or_else(|| "备忘录内容不能为空".to_string())?
        .to_string();
    // 模型工具调用走这里；分类交给 infer_memo_category 推断。
    Ok(MemoInput {
        title,
        content,
        category: None,
    })
}

pub(crate) fn memo_category_label(category: &str) -> &'static str {
    match category {
        "task" => "任务",
        "idea" => "想法",
        "learning" => "学习",
        "work" => "工作",
        "life" => "生活",
        "reference" => "资料",
        _ => "其他",
    }
}

pub(crate) fn infer_memo_category(title: &str, content: &str) -> String {
    let text = format!("{title}\n{content}").to_lowercase();
    let rules = [
        (
            "task",
            [
                "todo", "待办", "任务", "完成", "处理", "跟进", "提交", "检查", "修复", "提醒",
                "截止",
            ]
            .as_slice(),
        ),
        (
            "idea",
            [
                "想法", "灵感", "可以", "也许", "方案", "创意", "idea", "假设",
            ]
            .as_slice(),
        ),
        (
            "learning",
            [
                "学习", "笔记", "知识", "课程", "阅读", "概念", "总结", "复盘", "learn",
            ]
            .as_slice(),
        ),
        (
            "work",
            [
                "工作", "项目", "会议", "需求", "评审", "客户", "版本", "发布", "prd",
            ]
            .as_slice(),
        ),
        (
            "life",
            [
                "生活", "购物", "买", "家里", "旅行", "运动", "健康", "吃", "家庭",
            ]
            .as_slice(),
        ),
        (
            "reference",
            [
                "链接", "资料", "参考", "文档", "地址", "url", "http", "配置", "账号",
            ]
            .as_slice(),
        ),
    ];

    rules
        .iter()
        .find(|(_, keywords)| keywords.iter().any(|keyword| text.contains(keyword)))
        .map(|(category, _)| (*category).to_string())
        .unwrap_or_else(|| "other".to_string())
}

pub(crate) fn summarize_memo(title: &str, content: &str) -> String {
    let content = content.replace('\n', " ");
    let normalized = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        truncate_text(title, 80)
    } else if normalized.chars().count() <= 96 {
        normalized
    } else {
        format!("{}...", truncate_text(&normalized, 96))
    }
}

pub(crate) fn infer_memo_tags(category: &str, title: &str, content: &str) -> Vec<String> {
    let text = format!("{title}\n{content}").to_lowercase();
    let mut tags = vec![memo_category_label(category).to_string()];
    for (tag, keywords) in [
        ("紧急", ["紧急", "马上", "今天", "尽快", "asap"].as_slice()),
        ("会议", ["会议", "meeting", "评审", "同步"].as_slice()),
        ("代码", ["代码", "bug", "修复", "接口", "api"].as_slice()),
        ("资料", ["链接", "文档", "参考", "http", "资料"].as_slice()),
        ("计划", ["计划", "安排", "路线", "步骤"].as_slice()),
    ] {
        if keywords.iter().any(|keyword| text.contains(keyword)) {
            tags.push(tag.to_string());
        }
    }
    tags.sort();
    tags.dedup();
    tags.truncate(4);
    tags
}

pub(crate) fn memo_from_input(
    id: String,
    input: MemoInput,
    created_at: u64,
) -> Result<Memo, String> {
    let title = input.title.trim();
    let content = input.content.trim();
    if title.is_empty() {
        return Err("备忘录标题不能为空".to_string());
    }
    if title.chars().count() > 120 {
        return Err("备忘录标题不能超过 120 个字符".to_string());
    }
    if content.is_empty() {
        return Err("备忘录内容不能为空".to_string());
    }
    if content.chars().count() > 8000 {
        return Err("备忘录内容不能超过 8000 个字符".to_string());
    }

    let category = match input.category.as_deref() {
        Some(value) => {
            let value = value.trim();
            if value.is_empty() {
                infer_memo_category(title, content)
            } else if MEMO_CATEGORIES.contains(&value) {
                value.to_string()
            } else {
                return Err(format!("不支持的记录分类：{value}"));
            }
        }
        None => infer_memo_category(title, content),
    };
    let now = unix_timestamp();
    Ok(Memo {
        id,
        title: title.to_string(),
        content: content.to_string(),
        summary: summarize_memo(title, content),
        tags: infer_memo_tags(&category, title, content),
        category,
        created_at,
        updated_at: now,
    })
}

pub(crate) fn create_memo_record(app: &AppHandle, input: MemoInput) -> Result<Memo, String> {
    let _transaction = storage::transaction();
    let now = unix_timestamp();
    let id = agent_operations::next_id("memo").unwrap_or_else(memo_id);
    let memo = memo_from_input(id, input, now)?;
    let mut memos = read_memos(app);
    if let Some(existing) = memos.iter().find(|existing| existing.id == memo.id) {
        if existing.title == memo.title
            && existing.content == memo.content
            && existing.category == memo.category
        {
            return Ok(existing.clone());
        }
        return Err("备忘录已被修改，不能按原检查点覆盖，请先核对".into());
    }
    if !agent_operations::may_create() {
        return Err("备忘录未在检查点中找到，不能自动重建，请先核对".into());
    }
    memos.push(memo.clone());
    persist_memos(app, &memos)?;
    let _ = app.emit("memos-updated", ());
    Ok(memo)
}
