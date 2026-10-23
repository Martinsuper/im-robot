//! 调优参数集中地：影响记忆的存续、检索质量与维护节奏的数值都在这里命名。
//! 本模块只做命名收编——所有值与历史行为逐一一致；调整前先看引用处的对应测试。
//! （相关测试：extraction 批量上限、maintenance 敏感词过滤、store 置信度预算等。）

/// 事件类记忆的有效期（天）。
pub(crate) const EVENT_EXPIRY_DAYS: u64 = 90;
/// 操作记录类记忆的有效期（天）；档案/语义知识永不过期。
pub(crate) const OPERATIONAL_EXPIRY_DAYS: u64 = 60;
/// 标题相似度阈值（合并候选与反思去重共用）。
pub(crate) const TITLE_SIMILARITY_THRESHOLD: f32 = 0.7;
/// 每日维护单次收储的总上限（条，含重复）。
pub(crate) const MAINTENANCE_COLLECT_CAP: usize = 200;
/// 每日维护收储的置信度下限。
pub(crate) const MAINTENANCE_MIN_CONFIDENCE: f32 = 0.8;
/// 单次提取遍历的对话条数上限。
pub(crate) const EXTRACTION_BATCH_LIMIT: usize = 100;
/// 语义检索向量命中的余弦相似度下限。
pub(crate) const COSINE_THRESHOLD: f64 = 0.35;
/// 文档分块长度（字符）。
pub(crate) const CHUNK_SIZE: usize = 1000;
/// 从块首起搜索断句边界的起点偏移（字符）。
pub(crate) const CHUNK_BOUNDARY_FROM: usize = 600;
/// 分块之间的重叠长度（字符）。
pub(crate) const CHUNK_OVERLAP: usize = 120;
/// 每次请求上下文证据的条数上限。
pub(crate) const CONTEXT_HIT_LIMIT: usize = 8;
/// 上下文证据的总字符预算。
pub(crate) const CONTEXT_CHAR_BUDGET: usize = 14_000;
/// 单条文档证据的字符上限。
pub(crate) const CONTEXT_DOC_CHAR_CAP: usize = 1800;
/// 单条记忆证据的字符上限。
pub(crate) const CONTEXT_MEMORY_CHAR_CAP: usize = 1200;
/// 词法命中里标题词的权重。
pub(crate) const LEXICAL_TITLE_WEIGHT: f64 = 3.0;
/// 词法命中里正文词的权重。
pub(crate) const LEXICAL_CONTENT_WEIGHT: f64 = 1.0;
/// RRF 融合时各路候选列表的截断长度。
pub(crate) const RRF_LIST_CAP: usize = 60;
/// RRF 融合常数 k（排名 r 的权重为 1/(k + r + 1)）。
pub(crate) const RRF_K: f64 = 60.0;
/// 混合检索返回条数上限。
pub(crate) const RETRIEVAL_RESULT_CAP: usize = 30;
/// 关键词搜索的默认返回条数。
pub(crate) const SEARCH_DEFAULT_LIMIT: usize = 20;
/// 相关记忆搜索的默认返回条数。
pub(crate) const SEARCH_RELATED_DEFAULT_LIMIT: usize = 10;
/// 记忆上下文（build_context）的默认条数与上限。
pub(crate) const CONTEXT_MEMORY_DEFAULT_LIMIT: usize = 15;
pub(crate) const CONTEXT_MEMORY_MAX_LIMIT: usize = 100;
/// 上下文候选行的过取倍数与截断范围。
pub(crate) const CONTEXT_CANDIDATE_FACTOR: usize = 8;
pub(crate) const CONTEXT_CANDIDATE_MIN: usize = 64;
pub(crate) const CONTEXT_CANDIDATE_MAX: usize = 800;
/// 上下文里档案类记忆的配额上限。
pub(crate) const CONTEXT_PROFILE_BUDGET_CAP: usize = 2;
/// 上下文 LIKE 打分中标题/正文的权重。
pub(crate) const CONTEXT_LIKE_TITLE_WEIGHT: u32 = 2;
pub(crate) const CONTEXT_LIKE_CONTENT_WEIGHT: u32 = 1;
/// 相关度按日衰减的保底值。
pub(crate) const RECENCY_FLOOR: f32 = 0.1;
/// 记忆相关度的按日衰减系数（30 天约减半）。
pub(crate) const RECENCY_DECAY_PER_DAY: f32 = 0.02;
/// 反馈对置信度的增量（correct/incorrect/useful/useless）。
pub(crate) const CONFIDENCE_DELTA_CORRECT: f32 = 0.05;
pub(crate) const CONFIDENCE_DELTA_INCORRECT: f32 = -0.1;
pub(crate) const CONFIDENCE_DELTA_USEFUL: f32 = 0.03;
pub(crate) const CONFIDENCE_DELTA_USELESS: f32 = -0.05;

/// 每日维护收储时跳过的词（疑问/指令句式与高敏感字段；行为由 maintenance 测试钉住）。
pub(crate) const MAINTENANCE_BLOCKLIST: &[&str] = &[
    "?",
    "？",
    "请帮",
    "帮我",
    "改为",
    "不再",
    "纠正",
    "身份证",
    "银行卡",
    "住址",
    "病历",
    "诊断",
    "收入",
    "工资",
    "电话",
    "邮箱",
    "instead",
    "address",
    "salary",
    "medical",
];
