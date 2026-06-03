# Piko 桌面代理状态结构设计

> 依赖：[桌面代理接口设计](desktop-agent-api-spec.md)  
> 目标：定义桌面代理能力所需的前端状态、后端状态和持久化结构

## 1. 设计目标

桌面代理不是单个功能，而是一组会持续变化的状态。

这份设计的目标是把状态拆清楚：

- 哪些状态属于当前会话
- 哪些状态需要跨重启保存
- 哪些状态只用于 UI 展示
- 哪些状态只用于执行控制

## 2. 状态分层

### 2.1 临时状态

只存在于当前交互或执行周期内。

- 当前桌面整理计划
- 当前 Shell 草稿
- 当前剪贴板分析结果
- 当前提醒弹窗

### 2.2 会话状态

当前应用运行期间持续有效。

- 工作节律状态
- 今日输入统计
- 前台应用状态
- 当前专注状态
- 最近提醒记录

### 2.3 持久状态

需要跨重启保存。

- 今日输入统计的当天聚合值
- 历史输入聚合摘要
- 桌面整理执行记录
- Shell 执行记录摘要
- 用户对提醒策略的偏好

## 3. Rust 侧状态结构

### 3.1 工作节律状态

```rust
struct WorkRhythmState {
    date: String,
    is_idle: bool,
    idle_seconds: u64,
    active_app_category: String,
    typing_characters_today: u64,
    typing_seconds_today: u64,
    focus_status: String,
    focus_kind: String,
    focus_remaining_seconds: u64,
}
```

用途：

- 驱动提醒
- 提供面板展示
- 提供气泡中的节律提示

### 3.2 今日输入统计

```rust
struct TypingStatsToday {
    date: String,
    typed_characters: u64,
    typing_seconds: u64,
    updated_at: u64,
}
```

用途：

- 显示今日输入字符数
- 作为休息提醒的辅助信号
- 作为活跃度展示值

### 3.3 桌面项目

```rust
struct DesktopItem {
    name: String,
    path: String,
    item_type: String,
    category: String,
}
```

用途：

- 预览桌面内容
- 生成整理计划
- 让用户理解会移动什么

### 3.4 桌面整理计划

```rust
struct DesktopOrganizePlan {
    id: String,
    desktop_dir: String,
    planned_moves: Vec<DesktopOrganizeMove>,
    created_folders: Vec<String>,
    skipped_items: Vec<String>,
    created_at: u64,
    status: String,
}

struct DesktopOrganizeMove {
    from: String,
    to: String,
    category: String,
}
```

用途：

- 在确认前展示
- 在确认后执行
- 为执行结果和审计提供依据

### 3.5 Shell 草稿

```rust
struct ShellDraft {
    id: String,
    command: String,
    working_directory: String,
    timeout_seconds: u64,
    risk: String,
    summary: String,
    created_at: u64,
    status: String,
}
```

用途：

- 显示给用户确认
- 作为执行入口
- 作为中止和审计的锚点

### 3.6 剪贴板分析结果

```rust
struct ClipboardAnalysisResult {
    summary: String,
    redacted_content: String,
    suggested_actions: Vec<String>,
    created_at: u64,
}
```

用途：

- 前端展示
- 用户确认后生成后续动作
- 不保留原文

## 4. 前端状态结构

### 4.1 工作节律 UI 状态

```ts
interface WorkRhythmState {
  date: string;
  isIdle: boolean;
  idleSeconds: number;
  activeAppCategory: "editor" | "browser" | "meeting" | "game" | "other";
  typingCharactersToday: number;
  typingSecondsToday: number;
  focusStatus: "idle" | "running" | "paused";
  focusKind: "focus" | "break";
  focusRemainingSeconds: number;
}
```

### 4.2 桌面整理 UI 状态

```ts
interface DesktopOrganizePlan {
  id: string;
  desktopDir: string;
  plannedMoves: Array<{
    from: string;
    to: string;
    category: string;
  }>;
  createdFolders: string[];
  skippedItems: string[];
  createdAt: number;
  status: "draft" | "confirmed" | "executing" | "completed" | "failed";
}
```

### 4.3 Shell UI 状态

```ts
interface ShellDraft {
  id: string;
  command: string;
  workingDirectory: string;
  timeoutSeconds: number;
  risk: "pure" | "read" | "write" | "sensitive" | "forbidden";
  summary: string;
  createdAt: number;
  status: "draft" | "confirmed" | "running" | "completed" | "failed" | "cancelled";
}
```

### 4.4 剪贴板分析 UI 状态

```ts
interface ClipboardAnalysisResult {
  summary: string;
  redactedContent: string;
  suggestedActions: string[];
  createdAt: number;
}
```

## 5. 持久化建议

### 5.1 建议新增存储

- `typing-stats.json`
- `work-rhythm.json`
- `desktop-organize-history.json`
- `shell-execution-history.json`

### 5.2 存储原则

1. 只存聚合，不存明文。
2. 只存执行摘要，不存敏感输出。
3. 只存必要字段，不存上下文原文。
4. 历史记录保留有限天数。

### 5.3 不建议存储

- 键盘按键序列
- 剪贴板正文
- Shell 完整 stdout/stderr
- 桌面整理前后的完整文件索引快照

## 6. 状态流转

### 6.1 工作节律流转

```text
输入事件
  -> 今日输入统计更新
  -> 工作节律状态更新
  -> 休息提醒判断
  -> UI 刷新
```

### 6.2 桌面整理流转

```text
生成计划
  -> 预览计划
  -> 用户确认
  -> 执行整理
  -> 返回结果
  -> 写入摘要历史
```

### 6.3 Shell 流转

```text
生成草稿
  -> 预览草稿
  -> 用户确认
  -> 开始执行
  -> 可中止
  -> 返回结果摘要
```

### 6.4 剪贴板分析流转

```text
用户触发
  -> 单次读取
  -> 单次分析
  -> 显示脱敏结果
  -> 丢弃原文
```

## 7. 事件设计建议

### 7.1 `work-rhythm-updated`

用于通知工作节律状态变化。

### 7.2 `typing-stats-updated`

用于通知今日输入字符数变化。

### 7.3 `desktop-organize-planned`

用于通知桌面整理计划生成完成。

### 7.4 `desktop-organize-completed`

用于通知桌面整理执行完成。

### 7.5 `shell-draft-created`

用于通知 Shell 草稿生成完成。

### 7.6 `shell-execution-updated`

用于通知受控 Shell 执行状态变化。

### 7.7 `clipboard-analysis-ready`

用于通知剪贴板分析结果可展示。

## 8. 状态所有权

### 8.1 Rust 所有

- 今日输入统计
- 工作节律状态
- 桌面整理计划
- Shell 草稿和执行句柄
- 剪贴板分析结果的原始读取过程

### 8.2 前端所有

- 预览卡选择状态
- 当前展示的提醒文案
- 选中的桌面整理计划
- 选中的 Shell 草稿
- 结果展示状态

## 9. 设计原则

1. **状态先分类，再实现。**
2. **临时态和持久态分开。**
3. **敏感原文不进入持久化层。**
4. **UI 状态和执行状态分开。**
5. **事件流优先于轮询。**

## 10. 结论

只要状态结构先定好，后面的实现就会更顺。

这份设计把桌面代理需要的状态拆成了临时、会话和持久三层，后续我们可以直接按这个结构拆 Rust 模块和前端 store。
