# Piko Tool Use 与日程插件设计

> 文档版本：`v0.3`
> 状态：第二阶段已完成
> 依赖：[`plugin-architecture.md`](plugin-architecture.md)

## 1. 目标

让模型可以发现 Piko 已安装的业务插件，并通过统一 `ToolCall` 提出操作。提醒与日程等写入操作必须先生成草稿，经用户确认后执行。

本阶段实现：

- `piko.calendar` 内置日程插件。
- 本地日程事件持久化、创建、删除和冲突检测。
- 面板中的日程管理入口。
- 常见中文日程表达的本地草稿解析。
- 插件 manifest 到 OpenAI Compatible、Anthropic、Gemini tools schema 的映射函数。

OpenAI Compatible、Anthropic 和 Gemini 原生 Tool Use 已启用：请求会注入对应的 tools schema，流式工具调用会被聚合并校验。只读工具自动执行后回传模型继续生成；写入工具先生成确认草稿，确认执行后再将结构化结果交给模型生成自然语言收尾。系统提示会附带当前本地时间和时区。模型必须提交带时区的 ISO 8601 时间字符串，由 Rust 转换为 Unix 时间戳，避免依赖模型进行时间戳运算。若服务或模型拒绝 `tools` 字段，当前请求会自动降级为普通聊天。

## 2. 分层

```text
用户输入
  -> 本地意图解析器（确定性快捷路径）
  -> 或 ProviderToolAdapter（模型原生 Tool Use）
  -> ToolCall
  -> PluginRegistry
  -> ActionDraft
  -> 用户确认
  -> 插件 execute
  -> ToolResult
```

本地解析器用于高频、低歧义表达，不依赖网络：

```text
明天下午 3 点到 4 点安排项目评审
后天上午 10 点安排周会
```

复杂规划交给模型原生 Tool Use：

```text
帮我规划下周三次学习，每次一小时，避开已有会议
```

## 3. Provider Tool Adapter

插件 manifest 是唯一工具定义源。适配层只负责协议转换。

```rust
fn provider_tools(provider: &str, manifests: &[PluginManifest]) -> Value;
```

### OpenAI Compatible

```json
{
  "type": "function",
  "function": {
    "name": "piko_calendar__create_event",
    "description": "创建一条本地日程",
    "parameters": {}
  }
}
```

### Anthropic

```json
{
  "name": "piko_calendar__create_event",
  "description": "创建一条本地日程",
  "input_schema": {}
}
```

### Gemini

```json
{
  "functionDeclarations": [
    {
      "name": "piko_calendar__create_event",
      "description": "创建一条本地日程",
      "parameters": {}
    }
  ]
}
```

工具名编码规则：

```text
plugin_id: piko.calendar
tool:      create_event
wire name: piko_calendar__create_event
```

启用原生 Tool Use 时，适配器必须将 wire name 解码回 `ToolCall`，并限制最大调用轮数，避免模型无限循环。

## 4. 日程模型

```rust
struct CalendarEvent {
    id: String,
    title: String,
    start_at: u64,
    end_at: u64,
    location: Option<String>,
    notes: Option<String>,
}
```

第一版保存到应用配置目录下的 `calendar-events.json`。模型工具参数使用带时区的 ISO 8601 字符串；本地解析器生成的数值时间戳仍兼容。Rust 在插件边界完成归一化，持久化统一保存 Unix 时间戳。

冲突规则：

```text
existing.start_at < candidate.end_at
&& candidate.start_at < existing.end_at
```

边界相接不算冲突，例如 `10:00 - 11:00` 与 `11:00 - 12:00`。

## 5. 插件 Manifest

`piko.calendar` 声明：

| 工具 | 风险 | 确认策略 |
| --- | --- | --- |
| `list_events` | `read` | `never` |
| `detect_conflicts` | `read` | `never` |
| `create_event` | `write` | `always` |
| `create_event_batch` | `write` | `always` |
| `delete_event` | `sensitive` | `always` |
| `delete_event_batch` | `sensitive` | `always` |

批量日程使用一张确认卡展示候选项，用户可以取消勾选不希望写入的条目。执行时 Rust 会一次性检查已有日程与批次内部冲突，避免部分写入。

删除事件已支持对话确认与面板入口。对话删除使用 `sensitive` 风险等级和强确认卡，先定位目标再执行。删除多个或全部日程时使用 `delete_event_batch`，后端会先校验整批 ID 再一次性写入，避免只删除部分日程。已删除的本地 ID 会保留删除记录，防止系统日历镜像在后续回拉时重新导入。

## 6. 后续阶段

1. 在系统日历 Host API 之上增加双向同步；当前实现为 iCalendar 导出后交给系统日历导入。
2. 增加真正的 WASM 沙箱执行器；当前外部插件运行时仅允许声明式只读静态响应。
