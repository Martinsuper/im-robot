# Piko 桌面代理接口设计

> 依赖：[桌面代理实施设计](desktop-agent-implementation-design.md)  
> 目标：定义桌面代理层对前端和后端暴露的命令、事件与状态结构

## 1. 设计目标

这份接口设计的目标是把桌面代理相关能力拆成明确、稳定、可实现的边界：

- 前端知道该调用什么
- Rust 后端知道该返回什么
- 事件流知道怎么通知 UI
- 以后新增功能时不会破坏既有协议

## 2. 总体接口分组

### 2.1 感知类

用于收集低敏感度状态。

- 前台应用感知
- 空闲状态
- 今日输入字符数
- 今日输入活跃时长
- 剪贴板变化状态

### 2.2 操作类

用于执行明确动作。

- 列出桌面项目
- 打开路径
- 生成桌面整理计划
- 执行桌面整理
- 生成命令草稿
- 执行受控 Shell

### 2.3 提醒类

用于输出低打扰提示。

- 休息提醒
- 起身提醒
- 专注时长提醒
- 剪贴板分析提醒

## 3. 建议命令清单

### 3.1 工作节律相关

#### `get_work_rhythm_state`

返回当前工作节律状态。

建议返回：

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

#### `get_typing_stats_today`

返回今日输入统计。

建议返回：

```ts
interface TypingStatsToday {
  date: string;
  typedCharacters: number;
  typingSeconds: number;
  updatedAt: number;
}
```

#### `get_foreground_app_state`

返回前台应用类别信息。

建议返回：

```ts
interface ForegroundAppState {
  category: "editor" | "browser" | "meeting" | "game" | "other";
  appName: string;
  lastUpdatedAt: number;
}
```

### 3.2 桌面操作相关

#### `list_desktop_items`

返回桌面当前可见项目。

建议返回：

```ts
interface DesktopItem {
  name: string;
  path: string;
  itemType: "file" | "folder" | "shortcut";
  category: "images" | "documents" | "archives" | "code" | "shortcuts" | "other";
}
```

#### `open_path`

输入：

```ts
interface OpenPathInput {
  path: string;
}
```

返回：

```ts
interface OpenPathResult {
  openedPath: string;
}
```

#### `build_desktop_organize_plan`

生成桌面整理计划，但不执行。

建议返回：

```ts
interface DesktopOrganizePlan {
  desktopDir: string;
  plannedMoves: Array<{
    from: string;
    to: string;
    category: string;
  }>;
  createdFolders: string[];
  skippedItems: string[];
}
```

#### `execute_desktop_organize_plan`

执行桌面整理计划。

输入：

```ts
interface ExecuteDesktopOrganizePlanInput {
  planId: string;
}
```

返回：

```ts
interface DesktopOrganizeResult {
  planId: string;
  movedCount: number;
  skippedCount: number;
  createdFolders: string[];
  errors: string[];
}
```

### 3.3 受控 Shell 相关

#### `build_shell_draft`

把用户意图转换成可确认的命令草稿。

建议返回：

```ts
interface ShellDraft {
  id: string;
  command: string;
  workingDirectory: string;
  timeoutSeconds: number;
  risk: "pure" | "read" | "write" | "sensitive" | "forbidden";
  summary: string;
}
```

#### `execute_shell_draft`

执行确认后的命令草稿。

输入：

```ts
interface ExecuteShellDraftInput {
  draftId: string;
}
```

返回：

```ts
interface ShellExecutionResult {
  draftId: string;
  exitCode: number | null;
  stdoutPreview: string;
  stderrPreview: string;
  durationMs: number;
  cancelled: boolean;
}
```

#### `cancel_shell_execution`

用于中止正在执行的命令。

输入：

```ts
interface CancelShellExecutionInput {
  draftId: string;
}
```

### 3.4 剪贴板相关

#### `read_clipboard_once`

用户主动触发时读取一次剪贴板。

返回：

```ts
interface ClipboardReadResult {
  content: string;
  byteSize: number;
  mimeType: string | null;
}
```

#### `analyze_clipboard_once`

只对单次读取结果做分析，不长期保存原文。

输入：

```ts
interface AnalyzeClipboardOnceInput {
  purpose: "summary" | "rewrite" | "extract_todos" | "reply_draft";
}
```

返回：

```ts
interface ClipboardAnalysisResult {
  summary: string;
  redactedContent: string;
  suggestedActions: string[];
}
```

## 4. 事件设计

### 4.1 `work-rhythm-updated`

当工作节律状态变化时推送。

```ts
type WorkRhythmUpdatedEvent = {
  type: "work-rhythm-updated";
  payload: WorkRhythmState;
};
```

### 4.2 `typing-stats-updated`

当今日输入统计变化时推送。

```ts
type TypingStatsUpdatedEvent = {
  type: "typing-stats-updated";
  payload: TypingStatsToday;
};
```

### 4.3 `desktop-organize-planned`

当桌面整理计划生成时推送。

```ts
type DesktopOrganizePlannedEvent = {
  type: "desktop-organize-planned";
  payload: DesktopOrganizePlan;
};
```

### 4.4 `shell-draft-created`

当 Shell 草稿生成时推送。

```ts
type ShellDraftCreatedEvent = {
  type: "shell-draft-created";
  payload: ShellDraft;
};
```

### 4.5 `shell-execution-updated`

当受控命令执行状态变化时推送。

```ts
type ShellExecutionUpdatedEvent = {
  type: "shell-execution-updated";
  payload: {
    draftId: string;
    status: "running" | "completed" | "failed" | "cancelled";
  };
};
```

## 5. 状态管理建议

### 5.1 前端状态

建议前端至少维护这些状态：

- 工作节律状态
- 今日输入统计
- 当前前台应用状态
- 桌面整理计划预览
- Shell 草稿列表
- 受控执行中的命令
- 剪贴板分析结果

### 5.2 后端状态

建议后端至少维护这些持久或半持久状态：

- 今日输入统计聚合值
- 工作节律采样窗口
- 桌面整理计划缓存
- Shell 草稿缓存
- Shell 执行句柄

## 6. 接口设计原则

1. **读写分离。** 查询状态和执行动作分开。
2. **草稿优先。** 高风险动作必须先有草稿。
3. **事件驱动。** 前端不必靠轮询获取所有变化。
4. **最小返回。** 只返回 UI 和审计所需字段。
5. **可取消。** Shell 和长动作必须支持中止。

## 7. 实施顺序建议

### Phase 1

- `get_foreground_app_state`
- `get_typing_stats_today`
- `get_work_rhythm_state`
- `work-rhythm-updated`
- `typing-stats-updated`

### Phase 2

- `list_desktop_items`
- `open_path`
- `build_desktop_organize_plan`
- `desktop-organize-planned`

### Phase 3

- `build_shell_draft`
- `execute_shell_draft`
- `cancel_shell_execution`
- `shell-draft-created`
- `shell-execution-updated`

### Phase 4

- `read_clipboard_once`
- `analyze_clipboard_once`

## 8. 结论

接口先定清楚，后面实现就会很稳。

这份设计的核心不是“功能更多”，而是让桌面代理的每个动作都有明确的输入、输出和状态边界，便于前端、后端和确认流程一起协作。
