# Piko Tool Use 与日程插件设计

> 文档版本：`v0.2`  
> 状态：第二阶段进行中  
> 依赖：[`plugin-architecture.md`](plugin-architecture.md)

## 1. 目标

让模型可以发现 Piko 已安装的业务插件，并通过统一 `ToolCall` 提出操作。提醒与日程等写入操作必须先生成草稿，经用户确认后执行。

本阶段实现：

- `piko.calendar` 内置日程插件。
- 本地日程事件持久化、创建、删除和冲突检测。
- 面板中的日程管理入口。
- 常见中文日程表达的本地草稿解析。
- 插件 manifest 到 OpenAI Compatible、Anthropic、Gemini tools schema 的映射函数。

OpenAI Compatible 原生 Tool Use 已启用：请求会注入 tools schema，流式 `tool_calls` 会被聚合并校验。只读工具自动执行后回传模型继续生成；写入工具仍然先生成确认草稿。系统提示会附带当前本地时间和时区。模型必须提交带时区的 ISO 8601 时间字符串，由 Rust 转换为 Unix 时间戳，避免依赖模型进行时间戳运算。若本地服务或模型拒绝 `tools` 字段，当前请求会自动降级为普通聊天。Anthropic 和 Gemini 的原生 Tool Use 仍待实现。

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

删除事件暂时只提供面板入口。后续开放对话删除时，使用 `sensitive` 风险等级和强确认卡。

## 6. 后续阶段

1. 写入工具确认执行后，将工具结果回传模型生成自然语言收尾。
2. 接入 Anthropic `tool_use` / `tool_result`。
3. 接入 Gemini `functionCall` / `functionResponse`。
4. 增加批量 `ActionBatchDraft`，支持日程规划和冲突项勾选。
5. 增加 iCalendar 导出与系统日历 Host API。
