pub(crate) mod commands;
mod service;
use serde::{Deserialize, Serialize};
pub(crate) use service::*;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Memo {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) content: String,
    pub(crate) category: String,
    pub(crate) summary: String,
    pub(crate) tags: Vec<String>,
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoInput {
    pub(crate) title: String,
    pub(crate) content: String,
    /// 用户显式选择的分类。不传则由 `infer_memo_category` 推断。
    ///
    /// 之前这个字段不存在，于是界面上「记录」Tab 的分类下拉是一个**空操作**：
    /// 选了也不会生效，但用户以为生效了（00 §5.5「可见即可解释」）。
    #[serde(default)]
    pub(crate) category: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoSummaryGroup {
    pub(crate) category: String,
    pub(crate) count: usize,
    pub(crate) latest_updated_at: u64,
    pub(crate) summary: String,
    pub(crate) top_tags: Vec<String>,
}

pub(crate) const MEMO_CATEGORIES: [&str; 7] = [
    "task",
    "idea",
    "learning",
    "work",
    "life",
    "reference",
    "other",
];

#[cfg(test)]
mod tests;
