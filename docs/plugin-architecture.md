# Piko 业务插件架构

> 文档版本：`v0.1`  
> 状态：第一阶段已实施  
> 目标：让提醒、日程、搜索、笔记等能力通过统一协议接入对话，而不是写死在聊天链路中。

## 1. 背景

Piko 已有对话、提醒、专注模式和受控文件写入能力，但这些能力目前由固定的 Tauri IPC 命令提供。模型只能返回文本，无法提出受控操作。

本设计增加一层 **Piko 业务插件运行时**。它与 Tauri 原生插件职责不同：

| 层级 | 职责 | 示例 |
| --- | --- | --- |
| Tauri 原生插件 | 封装操作系统能力 | 通知、文件对话框、全局快捷键 |
| Piko 业务插件 | 向对话提供受控工具 | 创建提醒、读取日程、天气查询 |

模型永远不能直接调用任意 IPC、文件系统或 Shell。

## 2. 核心流程

```text
用户对话
  -> 本地解析器或模型 Tool Use
  -> ToolCall
  -> PluginRegistry 校验插件、工具和参数
  -> ActionDraft
  -> 按风险策略展示确认卡
  -> 用户确认
  -> 插件执行
  -> 返回结构化结果并刷新界面
```

第一阶段先使用本地解析器识别常见提醒表达，例如：

```text
明天下午 3 点提醒我提交周报
30 分钟后提醒我休息
每天 9 点提醒我开晨会
```

后续接入 OpenAI Compatible、Anthropic 和 Gemini 的原生 Tool Use 协议时，只替换 `ToolCall` 的来源，不改变插件执行边界。

## 3. Manifest

每个插件必须声明工具清单、参数 schema、风险等级和确认策略。

```json
{
  "id": "piko.reminders",
  "name": "提醒事项",
  "version": "1.0.0",
  "description": "创建和管理本地提醒",
  "tools": [
    {
      "name": "create_reminder",
      "description": "创建一条本地提醒",
      "inputSchema": {
        "type": "object",
        "required": ["title", "dueAt"],
        "properties": {
          "title": { "type": "string", "maxLength": 120 },
          "dueAt": { "type": "integer" },
          "repeat": {
            "enum": ["none", "daily", "weekly", "weekdays"]
          }
        }
      },
      "risk": "write",
      "confirmation": "always"
    }
  ]
}
```

## 4. 风险与权限

| 风险等级 | 示例 | 默认策略 |
| --- | --- | --- |
| `pure` | 计算器、单位换算 | 可自动执行 |
| `read` | 查询天气、读取日程 | 首次授权或每次确认 |
| `write` | 创建提醒、添加日程 | 每次确认 |
| `sensitive` | 发送消息、覆盖文件 | 强确认，并限制参数 |
| 禁止 | 任意 Shell、任意路径读写 | 不开放 |

插件必须遵循最小权限原则。即使插件 manifest 声明了某项能力，也只能通过 Piko 提供的 Host API 执行。

## 5. Rust 边界

第一阶段采用静态注册的 Rust 插件：

```rust
trait PikoPlugin {
    fn manifest(&self) -> PluginManifest;
    fn execute(&self, app: &AppHandle, tool: &str, input: Value)
        -> Result<Value, String>;
}
```

统一数据结构：

```rust
struct ToolCall {
    plugin_id: String,
    tool_name: String,
    arguments: Value,
}

struct ActionDraft {
    id: String,
    plugin_id: String,
    tool_name: String,
    summary: String,
    arguments: Value,
}
```

所有写入型调用先保存为短生命周期的 `ActionDraft`。只有 `confirm_chat_action` 可以执行草稿，`reject_chat_action` 负责丢弃草稿。

## 6. 外部插件演进

完成内置插件验证后，再开放可安装插件。插件包建议使用：

```text
plugins/
  piko.calendar/
    manifest.json
    plugin.wasm
```

推荐使用 WASM 沙箱：

- 不动态加载第三方原生库。
- 不向插件暴露任意 Shell。
- 不默认开放网络、文件系统和系统凭据。
- 网络访问、受控文件选择等能力通过显式 Host API 提供。
- 安装时展示 manifest 权限，启用前由用户确认。

对于必须依赖本机程序的插件，可使用独立 sidecar 进程和 JSON-RPC，但仍需沿用同一 manifest、权限和确认策略。

## 7. 计划中的内置插件

| 插件 | 工具 | 阶段 |
| --- | --- | --- |
| `piko.reminders` | `create_reminder` | 第一阶段 |
| `piko.calendar` | `list_events`、`create_event`、`detect_conflicts` | 第一阶段 |
| `piko.focus` | `start_focus`、`start_break` | 后续 |
| `piko.notes` | `create_note`、`append_note` | 后续 |

日程规划应先生成多条草稿，让用户逐条或批量确认，再写入系统日历或导出 iCalendar。

## 8. 第一阶段验收

- 注册表可列出内置插件 manifest。
- 常见中文提醒表达可在不连接模型的情况下生成草稿。
- 气泡展示提醒标题、具体时间、重复规则和确认按钮。
- 用户确认后复用现有提醒持久化与通知调度器。
- 用户拒绝后不产生提醒记录。
- 新增 Rust 单元测试覆盖解析、插件注册和风险策略。
