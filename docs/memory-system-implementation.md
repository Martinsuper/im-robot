# Piko 记忆系统实现方案

> 文档版本：`v1.0`
> 依赖文档：[memory-system-design.md](memory-system-design.md)
> 目标：把长期记忆、检索、反思和用户可控管理真正落到代码里

## 1. 实现目标

本方案是 `memory-system-design.md` 的工程落地版，关注的是：

1. Rust / React 如何拆模块。
2. 记忆如何存、怎么查、怎么总结。
3. 哪些 IPC 命令需要新增。
4. 前端记忆中心怎么呈现。
5. 如何在不破坏隐私和现有安全边界的情况下，让 Piko 真正“越用越懂你”。

## 2. 总体实现路径

### 2.1 分三期落地

#### 第一期：可用的持久记忆

- 记住用户档案
- 记住显式偏好
- 记住任务结果
- 支持查看 / 删除 / 清空

#### 第二期：可检索的长期记忆

- 检索相关记忆
- 自动注入上下文
- 记忆排序与去重
- 记忆关系维护

#### 第三期：会反思的成长系统

- 日反思 / 周反思
- 偏好归纳
- 记忆合并
- 反馈学习

---

## 3. 目录结构建议

### 3.1 Rust 侧

建议新增：

```text
src-tauri/src/
  memory/
    mod.rs
    model.rs
    policy.rs
    writer.rs
    retriever.rs
    reflection.rs
    store.rs
    migrate.rs
    index.rs
  commands/
    memory.rs
```

### 3.2 前端侧

建议新增：

```text
src/
  features/
    memory/
      MemoryCenter.tsx
      MemoryCard.tsx
      MemoryFilters.tsx
      MemoryDetail.tsx
      memoryTypes.ts
```

---

## 4. Rust 核心模块设计

### 4.1 `memory/model.rs`

负责统一定义记忆数据模型。

#### 数据结构建议

```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryItem {
    pub id: String,
    pub memory_type: MemoryType,
    pub title: String,
    pub content: String,
    pub source: MemorySource,
    pub importance: u8,
    pub confidence: f32,
    pub recency_score: f32,
    pub privacy_level: PrivacyLevel,
    pub status: MemoryStatus,
    pub created_at: u64,
    pub updated_at: u64,
    pub last_used_at: Option<u64>,
    pub expires_at: Option<u64>,
    pub tags: Vec<String>,
    pub embedding_id: Option<String>,
}
```

#### 记忆枚举

```rust
pub enum MemoryType {
    Profile,
    Event,
    Semantic,
    Operational,
    Reflection,
}
```

建议 `serde(rename_all = "camelCase")`，与现有 IPC / JSON 风格保持一致。

---

### 4.2 `memory/policy.rs`

负责“记什么、不记什么、记多久、是否需要确认”。

#### 核心职责

- 敏感内容过滤
- 候选记忆分类
- 置信度计算
- 过期策略
- 用户确认策略

#### 输入

- 对话文本
- 工具调用结果
- 任务完成结果
- 用户反馈

#### 输出

- 允许写入的记忆候选
- 需要确认的记忆候选
- 不写入的候选

#### 建议规则

1. 用户明确说“记住” -> 高优先级
2. 偏好类内容 -> 优先写入用户档案
3. 任务结果 -> 写入事件记忆
4. 重复出现的模式 -> 周期性抽象成语义记忆
5. 涉及敏感内容 -> 默认不写或只写脱敏摘要

---

### 4.3 `memory/store.rs`

负责记忆持久化。

#### 推荐实现

优先用 SQLite，不建议继续用纯 JSON 作为主存储。

SQLite 的好处：

- 支持索引
- 支持查询
- 适合长期演进
- 容易做迁移

#### 建议表

```sql
memory_items
memory_tags
memory_relations
memory_feedback
memory_summaries
memory_migrations
```

#### 访问方式

- 读：按 ID、类型、标签、时间范围查询
- 写：事务写入
- 删：逻辑删除优先，必要时物理删除

---

### 4.4 `memory/writer.rs`

负责把输入信号变成记忆。

#### 输入来源

- `chat_start`
- `chat_completed`
- `tool_result`
- `confirm_chat_action`
- `preferences_updated`
- `focus_completed`

#### 写入流程

```text
原始事件
  -> 提取候选
  -> 规则过滤
  -> 类型判断
  -> 置信度评分
  -> 冲突检查
  -> 存储
  -> 可选生成摘要
```

#### 需要做的事

- 将长对话转成短记忆
- 从明确偏好里生成 profile memory
- 从任务结果里生成 event memory
- 从多个事件里生成 semantic memory

---

### 4.5 `memory/retriever.rs`

负责回答前检索记忆。

#### 检索输入

- 当前用户问题
- 当前会话主题
- 当前窗口场景
- 最近任务状态
- 当前时间和时区

#### 检索输出

建议输出为结构化片段：

```text
用户偏好
相关事件
当前任务状态
近期反思
```

#### 排序建议

1. 用户显式偏好
2. 当前问题直接相关
3. 当前任务相关
4. 最近发生
5. 高置信度语义记忆

---

### 4.6 `memory/reflection.rs`

负责日反思、周反思和记忆抽象。

#### 主要任务

- 汇总最近交互
- 发现重复模式
- 抽象出语义记忆
- 合并重复记忆
- 标记过期或低价值记忆

#### 调度建议

- 每天一次轻量反思
- 每周一次深度反思
- 每次重要任务完成后做局部总结

---

### 4.7 `memory/migrate.rs`

负责 schema 演进。

#### 迁移原则

- 不破坏旧数据
- 每次升级只做单向迁移
- 每步迁移都可重试
- 保留迁移日志

---

### 4.8 `memory/index.rs`

负责可选的检索索引。

#### 可以先不做复杂向量库

第一版可以先用：

- `LIKE`
- `fts5`
- 标签过滤
- 时间排序
- 置信度排序

如果后续记忆量上来，再考虑向量索引。

---

## 5. Tauri IPC 设计

### 5.1 记忆相关命令

建议新增命令：

```text
list_memories
get_memory_detail
search_memories
update_memory
delete_memory
clear_memories
pin_memory
unpin_memory
feedback_memory
refresh_memory_summaries
get_memory_profile
```

### 5.2 写入相关命令

```text
capture_memory_candidates
apply_memory_candidates
reject_memory_candidate
reflect_memory_now
```

### 5.3 检索相关命令

```text
build_memory_context
search_related_memories
get_recent_memories
get_memory_summaries
```

### 5.4 事件

建议新增事件：

```text
memory-updated
memory-reflected
memory-feedback-updated
memory-context-updated
```

---

## 6. 与聊天流程的集成

### 6.1 聊天前

在 `chat_start` 前，先构建 memory context：

1. 读取当前会话上下文
2. 检索相关长期记忆
3. 将结果合并进 system prompt 或 additional context
4. 进入模型请求

### 6.2 聊天后

在 `chat_completed` 后，提取候选记忆：

1. 从回复内容中提取偏好和事实
2. 从用户反馈里提取是否命中
3. 判断是否进入记忆库
4. 生成需要确认的条目

### 6.3 工具调用后

工具调用结果是非常好的记忆来源：

- 任务最终结果
- 用户选择
- 重复失败的场景
- 工具偏好

---

## 7. 前端记忆中心设计

### 7.1 页面位置

建议放在 `panel` 中新增一个 `记忆` Tab。

### 7.2 页面内容

建议至少包含：

- 用户档案
- 最近记忆
- 高价值记忆
- 反思摘要
- 待确认推断
- 搜索框
- 过滤器

### 7.3 记忆卡片字段

每张卡建议展示：

- 标题
- 类型
- 来源
- 重要性
- 置信度
- 更新时间
- 操作按钮

### 7.4 支持操作

- 查看详情
- 编辑
- 固定
- 降权
- 删除
- 合并
- 标记无效

---

## 8. UI 与交互细节

### 8.1 记忆提示

当 Piko 使用某条记忆时，可以轻提示：

> 我记得你更喜欢简洁结构化回复，所以我先给结论。

这会让“记得住”变成用户能感知到的体验。

### 8.2 待确认推断

某些语义归纳不要直接写入用户档案，先放到“待确认”列表：

- “你是不是更喜欢晚上处理这类任务？”
- “你是否希望以后默认少打扰？”

用户确认后再升级为稳定偏好。

### 8.3 删除优先级

用户删除必须是最高优先级：

- 立即从 UI 隐藏
- 后台异步清索引
- 反思引用失效

---

## 9. 隐私与保留策略

### 9.1 默认原则

- 默认本地保存
- 默认不上传
- 默认不保留敏感原文

### 9.2 保留期建议

- 事件记忆：可设置过期时间
- 语义记忆：保留更久，但可被新记忆覆盖
- 反思记忆：建议按周/月归档

### 9.3 敏感信息处理

遇到可能敏感内容时：

- 不写入
- 脱敏后写入
- 或仅会话内短暂保留

---

## 10. 性能策略

### 10.1 不要全量扫描

检索时不要扫全库后再排。
建议至少有：

- 时间索引
- 类型索引
- 标签索引
- FTS 索引

### 10.2 分层加载

界面中只先加载：

- 最近记忆
- 摘要
- 关键档案

点击详情再加载完整内容。

### 10.3 异步化

反思和摘要不要阻塞主聊天链路，应该：

- 后台异步执行
- 完成后发事件给前端

---

## 11. 测试计划

### 11.1 单元测试

建议覆盖：

- 记忆写入过滤规则
- 置信度计算
- 检索排序
- 合并与去重
- 删除与级联失效
- 敏感内容拦截

### 11.2 集成测试

- 用户明确说“记住这个”
- 用户删除后不再检索到
- 反思后是否生成语义记忆
- 记忆是否能影响回答风格

### 11.3 人工验证

- 记忆中心是否可读
- 用户是否知道自己被记住了什么
- 用户是否能放心删除

---

## 12. 里程碑

### M1：持久记忆

- 用户档案
- 事件记忆
- 查看 / 删除

### M2：上下文检索

- 相关记忆检索
- 上下文组装
- 记忆排序

### M3：反思总结

- 日反思
- 周反思
- 语义记忆抽象

### M4：反馈学习

- 用户反馈
- 偏好修正
- 记忆权重调整

---

## 13. 推荐执行顺序

### 第一优先

1. SQLite 记忆表
2. 记忆写入规则
3. 记忆检索命令
4. 记忆中心基础 UI

### 第二优先

5. 反思引擎
6. 周总结与合并
7. 用户反馈

### 第三优先

8. 更强的相似度检索
9. 向量索引
10. 个性化路由

---

## 14. 关键决策

### 14.1 先不做模型微调

建议优先把“记忆、检索、反思、反馈”做好，不要一上来就上参数级微调。

### 14.2 先本地优先

长期记忆默认保存在本地，云同步作为后续可选增强。

### 14.3 先可解释再智能

用户必须知道 Piko 为什么这么记、为什么这么回。

---

## 15. 结论

如果按这个实现方案推进，Piko 的“持久记忆”和“越用越聪明”会变成一套真正可维护、可扩展、可解释的系统，而不是简单地把更多聊天历史塞给模型。

最重要的不是“记更多”，而是：

- 记对
- 找得到
- 会总结
- 能修正
- 用户可控

