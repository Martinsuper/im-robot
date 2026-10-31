# 委托式任务代理：线路协议与跨层契约

实现 [PRD 04 委托式任务代理](../prd/04-delegated-task-agent.md) 的 P0+P1 范围时，三层（Node sidecar、Rust 宿主、前端）共同遵守的精确契约。协议版本 2 的字段表由 `src-tauri/src/agent_protocol.rs` 拥有，手工同步到 `agent/wire-schema.mjs` 并经 `npm run agent:prepare` 拷贝到 `src-tauri/agent-runtime/`。

## 1. 协议 v2 事件（sidecar → 宿主 → 前端）

必需字段（字符串）在 `agent_protocol.rs::EVENT_FIELDS` 校验；其余字段可选、可为对象/数字。

| 事件 | 必需字段 | 可选载荷 | 发出时机 |
| --- | --- | --- | --- |
| `contract-proposed` | `contractId` | `contract`（对象，见 §3） | 编排器生成契约草案后，等待 `contract` 命令 |
| `milestone` | `milestoneId`、`status` | `title`、`note` | 里程碑开始/完成/失败/跳过；`status ∈ started/completed/failed/skipped` |
| `notice` | `level`、`text` | — | 黄旗上报；`level ∈ info/warn` |
| `usage` | — | `milestoneId`、`inputTokens`、`outputTokens`、`elapsedMs` | 每个模型回合结束后 |
| `receipt` | `status` | `summary`、`receipt`（对象，见 §4） | 任务终态前最后一次结构性汇报；`status ∈ completed/suspended` |

`receipt` 事件之后紧跟既有的 `completed`（或 `failed`/`cancelled`）终态事件，顺序固定。

## 2. 协议 v2 命令（宿主 → sidecar）

| 命令 | 载荷 | 语义 |
| --- | --- | --- |
| `start`（扩展） | 现有字段 + `taskKind`、`policy`、`budget`、`projectId`、`verifyCommand`、`gitMode` | `taskKind ∈ companion(默认)/coding`；`policy` 见 §5；`budget: { timeMinutes, tokenBudget }`（0 = 不限）；`gitMode ∈ branch/files-only/off` |
| `contract`（新增） | `requestId`、`contractId`、`approved`、`contract`、`gitMode`、`policy` | 用户对契约的裁决；`approved=false` 时任务以 `cancelled` 终态收场（附原因"用户未确认任务契约"）；`policy` 为用户在契约卡片选择的档位（宿主按 §5 预设解析后的对象） |
| `steer`（扩展） | 现有字段 + `mode` | `mode ∈ redirect(默认)/guidance`；`guidance` 在下一里程碑边界注入且**不**吊销授权、不关闭自动批准；`redirect` 沿用现有立即注入 + 吊销语义 |

## 3. 契约对象（contract）

```json
{
  "goal": "一句话目标复述",
  "milestones": [
    { "id": "m1", "title": "里程碑标题", "acceptance": "该里程碑的验收描述" }
  ],
  "verifyCommand": "npm run verify",
  "timeMinutes": 90,
  "risks": ["模型希望用户注意的风险点"]
}
```

- 编排器生成草案（`contractId` 由 sidecar 生成，`crypto.randomUUID()`）。
- 用户可在前端编辑里程碑（增删改）与 `verifyCommand`，宿主把编辑后的对象随 `contract` 命令回传；以回传对象为准。
- `timeMinutes` 覆盖 start 的 `budget.timeMinutes`（取两者较小值由宿主裁决）。

## 4. 回执对象（receipt）

```json
{
  "milestones": [ { "id": "m1", "title": "…", "status": "completed", "note": "…" } ],
  "filesChanged": [ { "path": "src/foo.ts", "added": 12, "removed": 3 } ],
  "verify": [ { "command": "npm run verify", "ok": true, "output": "尾部截断输出" } ],
  "notices": [ { "level": "warn", "text": "…" } ],
  "branch": "piko/task-a1b2",
  "commits": [ "abc1234" ],
  "openQuestions": ["…"]
}
```

- `filesChanged` 来自 `git diff --numstat`（`gitMode=off` 时留空数组）。
- `commits` 为本任务分支上新增提交的短哈希。

## 5. 任务级自主权（policy）

```json
{ "workspaceFiles": "auto", "shell": "confirm", "outsideWorkspace": "confirm" }
```

| 预设（宿主裁决后下发） | workspaceFiles | shell | outsideWorkspace |
| --- | --- | --- | --- |
| 谨慎 cautious | confirm | confirm | confirm |
| 标准 standard（默认） | auto | confirm | confirm |
| 信任 trusted | auto | auto | confirm |

- sidecar 侧：`workspaceFiles=auto` 时工作区内 `write/edit` 免审批（写前检查点与读回验收不变）；`shell=auto` 等价于现有 `autoApproveCommands`；`outsideWorkspace` 恒为 confirm（v2 不提供自动档）。
- 危险命令启发式（`rm -rf`、`git push --force`、写系统路径等）在 `shell=auto` 下仍强制走审批（尽力而为）。
- 黄旗（`notice`）始终开启于 coding 任务：安装依赖、计划外新增文件、创建/删除分支。
- companion 任务一律使用现状行为（等价 cautious + 无黄旗），不受本节影响。

## 6. git 安全网（sidecar 编排器直接执行系统 git CLI）

- `gitMode=branch`：start 时工作区干净 → 从当前 HEAD 开 `piko/task-<requestId 前 4 位>` 分支；每个里程碑验收通过后 `git add`（仅任务触碰文件）+ `git commit -m "piko(task): <milestoneId> <title>"`。
- `gitMode=files-only`：工作区脏 → 不建分支，仅按任务触碰文件提交。
- `gitMode=off` 或非 git 仓库：跳过，回执注明。
- `git push` 永远不由编排器或模型执行（红项）。

## 7. 层间分工

| 层 | 负责 | 不碰 |
| --- | --- | --- |
| Node（`agent/`） | 编排器（契约生成/里程碑循环/验收执行/git/回执）、taskKind 提示分域、policy 裁决、usage 采集、guidance/redirect、SDK retry 与 thinking、`src-tauri/agent-runtime/` 副本同步（cp） | `src-tauri/src/**`、`src/**` |
| Rust（`src-tauri/src/`） | 事件转发与快照、`contract` 命令通道、活性超时与预算、journal 扩容（2048+归档+fsync 节流）、项目注册表（`projects.json` + project_* 命令）、宠物/通知接线、ambient busy、`agent_approve` 归属校验 | `agent/**`、`src/**` |
| 前端（`src/`） | 契约确认卡片、里程碑时间线、回执卡片、转向模式选择、项目切换器、新事件的状态投影 | `agent/**`、`src-tauri/**` |

## 8. 超时与预算语义（宿主）

- 活性超时（默认 10 分钟）：仅在"无工具运行 && 无审批等待 && 无契约等待"时计数；工具运行单列上限（默认 20 分钟，可配）。
- 任务预算：coding 默认 90 分钟（`budget.timeMinutes` 或契约 `timeMinutes` 取小），companion 保持 30 分钟；预算耗尽 → 宿主请求编排器优雅收尾（发 `cancel` 前先注入收尾指令，编排器发 `receipt` 后自然终态）。
- 审批超时：委托 coding 任务 30 分钟（可配），其余维持 5 分钟。

## 9. P2 增补契约

| 面 | 契约 | 说明 |
| --- | --- | --- |
| 预算收尾协议化 | `steer` 命令新增可选 `reason` 字段 | 宿主发 `{"type":"steer","text":"…收尾…","mode":"guidance","reason":"budget"}`；sidecar 以 `reason==="budget"` 为权威收尾信号，文本匹配仅作旧宿主回退 |
| 任务日志读取 | Tauri 命令 `agent_read_task_log(requestId)` → `{ exists, content, truncated }` | 读 `<workspace>/.piko/task-<requestId>.md`，上限 256KB 截断；前端日志查看/批注用 |
| 步骤归档读取 | Tauri 命令 `agent_get_task_steps(requestId, includeArchive)` → `{ steps, archivedCount }` | 归档段从 `agent/steps-archive/<id>.json` 读；前端"完整流水"用 |
| 定时委托 | `scheduled_tasks.json`（app_data_dir）：`{ id, prompt, projectId?, workspace?, policy?, timeMinutes?, scheduledAt, status: pending/fired/cancelled/failed }`；命令 `scheduled_task_list/create/cancel`（create 为扁平 `input` 传参，`scheduledAt` 为 unix 秒，前端 ISO 字符串在 `agentWire.createScheduledTask` 归一） | 到期由 SUPERVISOR 线程拉起任务（conversationId 取 `scheduled-<projectId|目录哈希>`，会话隔离），复用 agent_concurrency 与通知链路 |
| 崩溃自动续跑 | coding 任务 sidecar EOF 自动 respawn 一次（沿 `resume_of` 链，检查点防重复写入），同一任务链最多一次 | 宿主行为；事件流以 `notice` 告知 |
| 前端任务排队 | busy 时新输入入本地队（内存态，每会话串行），终态后自动发送队首 | 纯前端行为 |
| 任务记录视图 | `agent_list_tasks` 返回 JsonValue 数组：journal 的 `TaskRecord` 字段 + 内存快照合并的 `prompt`/`cwd`（可选，重启后缺失）；`TaskRecord` 持久化 `contractPending`/`contractId` 契约痕迹 | 前端经 `toTaskRecords()` 防御性收敛；"重新发起"依赖快照字段，重启后降级 |
