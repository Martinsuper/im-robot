# 委托式任务代理：自主执行与方向把控

## 1. 目标与非目标

### 1.1 目标

把 Piko 的任务模型从"单轮助手调用"升级为"委托制"：用户给出任务与边界，Piko 自主决策、连续执行直到完成；方向由**任务契约、可执行验收、任务日志**三个锚点把控，用户随时可以转向；用户**审结果，不审过程**。

- 任务可以长时间自主运行（小时级），不被超时、审批、步骤上限打断。
- 方向不跑偏：执行前一次契约确认，执行中自动验证与里程碑提交，执行后一张回执。
- 转向轻量：聊天插话、任务日志批注、打回重跑，均不要求用户盯守。
- 保持 Piko 形态：任务状态映射到宠物动画与系统通知，委托完该干嘛干嘛。

### 1.2 非目标

- 不做 IDE 替代品或逐 diff 审阅工具；代码工作最终仍回到用户的编辑器。
- 不做无边界自主：破坏性操作与工作区外写入仍然停下确认（见 4.3 分级策略）。
- 不改变现有统一聊天、业务插件（提醒/日程/备忘/专注）任务的行为；`taskKind` 默认保持现状。

## 2. 核心概念与交互总览

| 概念 | 定义 |
| --- | --- |
| 任务契约 | 执行前由模型生成、用户确认一次的结构化声明：目标复述、里程碑（3–5 个）、验收命令、自主档位、预算 |
| 里程碑 | 契约中的执行单元；每个里程碑结束后自动跑验收命令并提交 git |
| 验收命令 | 项目级可执行命令（如 `npm run verify`），由**编排器代码**而非模型执行，是方向的硬锚点 |
| 任务日志 | 编排器维护的双向文件（`.piko/task-<id>.md`）：已完成 / 下一步 / 疑问；用户可写批注，下一轮作为指令注入 |
| 分级自主权 | 绿（自动执行）/ 黄（执行但显著上报）/ 红（停下确认）三级策略，替代逐操作审批 |
| 回执 | 任务结束后的结构化卡片：里程碑状态、改动文件与 diffstat、验收结果、黄旗记录、分支与提交区间 |
| 转向 | `guidance`（下一里程碑边界注入，不吊销授权）与 `redirect`（立即注入，沿用现有吊销语义）两类插话 |

```
用户提任务 ──► 契约生成 ──► 用户确认一次（可编辑里程碑/验收/档位）
                                │
                                ▼
                  ┌──────► 执行里程碑 n ──► 跑验收命令 ──► git 提交
                  │             ▲                │失败
        插话/日志批注           │                ▼
        （guidance）───────────┘          注入报告自诊断（预算内重试 ≤2）
                                                   │仍失败
                                                   ▼
                              挂起（红旗问题停下问）或跳过（按契约）
全部完成 ──► 回执卡片 ──► 接受 / 打回（附反馈自动续跑）/ 丢弃分支
```

## 3. 现状问题清单

以下问题来自对 `agent/`（Node sidecar）、`src-tauri/src/`（宿主）与 `src/features/`（前端）的逐一核查，是本方案要补足的全部现状缺口。行号为当前 main 分支。

### 3.1 运行时（agent/）

| # | 问题 | 证据 | 对委托任务的影响 |
| --- | --- | --- | --- |
| R1 | 任务 = 单次 `session.prompt()`，无任务级循环与规划 | `agent/sidecar.mjs:146-157`；`AgentStartInput` 仅一个 `prompt` 字段（`src-tauri/src/agent.rs:140`） | 没有"计划→执行→验收→推进"的结构，方向无从锚定 |
| R2 | 30 分钟硬性总时限，deadline 启动时一次设定，**包含等审批时间** | `src-tauri/src/agent.rs:27-28, 883` | 小时级任务必然撞死 |
| R3 | 10 分钟 idle 超时同样计入等审批与长命令运行 | `src-tauri/src/agent.rs:26-27`；长命令不产 stdout 即被判 idle | 跑一次长构建/测试就被杀 |
| R4 | ApprovalGate 固定 5 分钟超时；超时后任务"继续运行"但每个变更必然拿不到授权 | `agent/permissions.mjs:24-38` | 无人值守多步审批必然逐个失败 |
| R5 | 每个变更单独审批，无任务级策略；唯一的自动化开关是全局 `agent_auto_approve_commands` 且只豁免 bash | `agent/permissions.mjs:12-20`；`functional.test.mjs:67-83` | 自主性被逐操作审批打断 |
| R6 | steer 一次就永久关闭命令自动批准并撤销文件操作授权 | `agent/sidecar.mjs:181-185`；`src-tauri/src/agent.rs:1004-1008` | 中途补一句话，后续全部退化为逐个人工审批 |
| R7 | 无预算控制：事件表无 usage 事件，成本恒零，无 token/时间/步骤预算字段 | `agent/wire-schema.mjs:3-38`；`agent/sdk-adapter.mjs:70-71` | 无法核算、无法"预算耗尽优雅收尾" |
| R8 | 上下文窗口默认仅 32000（Rust 默认 0 → 回退值），压缩在约 15.6k token 即触发，近期保留 20k | `src-tauri/src/app_settings.rs:153-155`；`agent/model-limits.mjs:2-9`；SDK `settings-defaults.js:7-11` | 长任务代码上下文被频繁摘要，方向漂移 |
| R9 | 协议 v1 锁死，仅 12 种事件，无里程碑/计划/预算/回执事件 | `src-tauri/src/agent_protocol.rs:4-20`；`agent/wire-schema.mjs:3-38` | UI 只能显示扁平工具流水 |
| R10 | 无瞬态错误重试：SDK `retry:{enabled:false}`，HTTP 401/429/500 直接 failed | `agent/sdk-adapter.mjs:76-77`；`functional.test.mjs:156-161` | 模型请求一抖动，30 分钟工作停在 failed |
| R11 | 领域规则污染编码任务：宠物人格、业务工具规则、"用中文简洁汇报"对一切任务注入，无编码分支 | `agent/sdk-adapter.mjs:90`；`src-tauri/src/chat.rs:49-85` + `agent.rs:799-804`；`agent/execution.mjs:14` | 编码任务的提示词被助手人格与无关规则占据 |
| R12 | unified 模式未预选目录时编码工具全部未激活，必须等用户选目录；续跑模式禁用 shell，无法跑验证 | `agent/sidecar.mjs:128-137`；`agent/sdk-adapter.mjs:13, 87` | 与"自主执行"直接矛盾；续跑后无法验收 |
| R13 | journal 每任务 256 步骤上限，超出直接终止任务 | `src-tauri/src/agent_journal.rs:148-150` | 正常编码任务（每文件 read+edit+bash）很容易超 |
| R14 | 推理能力硬编码关闭：`reasoning:false`、`thinkingLevel:"off"` | `agent/sdk-adapter.mjs:68-77` | 复杂编码任务没有思考预算 |
| R15 | bash/PowerShell 无检查点，shell 副作用不可验收不可重放；>20MB 文件写入永远 `unknown` | `agent/sidecar.mjs:107-109`；`agent/file-operations.mjs:8` | 失败后无法安全续跑 shell 步骤 |

### 3.2 宿主层（src-tauri/）

| # | 问题 | 证据 | 对委托任务的影响 |
| --- | --- | --- | --- |
| H1 | 任务运行时三元组纯内存，无持久化任务注册表 | `src-tauri/src/agent.rs:47-52` | 重启只剩 journal 的 `interrupted` 标记，需手动续跑 |
| H2 | 崩溃无恢复：stdout EOF 仅报 failed，不采集退出码、无重试、无心跳 | `src-tauri/src/agent.rs:889-891` | 长任务中途崩溃全部作废 |
| H3 | 应用退出只给 3 秒收尾 | `src-tauri/src/bootstrap.rs:496-500`；`background.rs:170-191` | 关窗口 = 丢任务 |
| H4 | 全 git 盲区：宿主与 sidecar 均无任何 git 代码/依赖，文件写入唯一安全网是 hash 检查点 + 读回 | 全仓 grep 证实；`agent/file-operations.mjs:44-74` | 无法回滚已写内容，无法"任务级丢弃" |
| H5 | 并发过窄：单会话 1 任务、全局 2 并行、工作目录前缀互斥，系统工具是全局单把互斥锁 | `agent_concurrency.rs:3, 11-46`；`agent.rs:51, 1100-1135` | 一个长任务占锁，其余任务阻塞 |
| H6 | 任务完成/失败/待审批均不发系统通知；唯一兜底是失败任务次日 9 点 soul 提醒 | `agent.rs:984`；`memory/soul/tasks.rs:46-55` | 气泡隐藏时用户对"在等你"完全无感 |
| H7 | `agent_approve` 不校验 approvalId 归属，依赖快照清理兜底 | `agent.rs:1011-1032` | 审批通道可被误用（低风险，需收紧） |
| H8 | journal 每个工具事件同步 fsync | `agent.rs:909-915`；`agent_journal.rs:51-60` | 长任务高频工具调用 IO 放大 |
| H9 | 定时只能发通知不能 spawn 任务（提醒调度器与任务无桥接） | `reminder_service/scheduler.rs:24-46` | "明早自动跑测试"类委托无法表达 |

### 3.3 前端（src/features/）

| # | 问题 | 证据 | 对委托任务的影响 |
| --- | --- | --- | --- |
| F1 | 无里程碑/计划概念，UI 只有 `<details>` 工具流水 | `wire-schema.mjs:3-38`；`AgentActivity.tsx:16-23` | 看不到"分几步、走到哪" |
| F2 | 插话单条在途，未确认时新输入**静默丢弃**；无语义区分（补充/转向/取消后面步骤） | `BubbleWindow.tsx:901-909` | 长任务中途基本无法有效转向 |
| F3 | busy 拦截新任务，无排队 | `BubbleWindow.tsx:818` | 委托第二个任务要先干等 |
| F4 | 无回执：结束后只有工具计数 + 文件路径列表（自述"未独立检查文件内容"），无 diff、无验收结果、无结构化总结 | `TaskOutcome.tsx:24-46`；`taskOutcomeModel.ts:11-16` | "审结果"没有对象 |
| F5 | completed 任务隐藏诊断 | `TaskDiagnostics.tsx:8` | "看似成功"的问题无从查证 |
| F6 | 工作目录是扁平 cwd 字符串存 localStorage，无项目概念、无最近项目 | `agentTypes.ts:26-27`；`BubbleWindow.tsx:170-177, 996` | 每次委托都要重新对齐上下文 |
| F7 | 待审批/待选目录是模态等待，无出窗触达；宠物与任务零关联（PetWindow 只监听旧聊天路径的 `chat-event`，不监听 `agent-event`） | `AgentActivity.tsx:24-36`；`PetWindow.tsx:262-288` vs `agent.rs:257`；`ambient.rs:126-140`（busy 不含 agent 任务） | 无人值守时任务静默挂起，宠物还会误入 resting |
| F8 | 宠物 `working/confirming/success/error` 模式现成未接入任务流；soul 快照的 agent 字段恒为 null | `BubbleWindow.tsx:1349, 1470, 1482`；`proactiveBridge.ts:49-60`；`memory/soul/commands.rs:104-106` | 差异化形态的挂点全部闲置 |
| F9 | 快照仅内存、仅最近 64 组工具事件；terminal 后事件被硬丢弃 | `agent_snapshot.rs:1-19, 51-53, 98-119`；`agentTaskState.ts:31` | 重启丢 UI；长任务早期步骤消失 |
| F10 | 委托入口单一：只有聊天一句话，无契约表单/档位/预算输入 | `BubbleWindow.tsx:1617-1666` | 契约确认无处落地 |

### 3.4 可复用的现成资产

- SDK 自动压缩（默认开启）与 steering/followUp 队列语义（SDK `how-pi-works.md`）。
- 事件序列号 + "先订阅后取快照"恢复模式（`agentTaskRecovery.ts:11-48`、`agent.rs:235-258`）。
- `AgentRuntime::activity()` 已返回（忙、待确认）权威信号（`agent.rs:79-87`）。
- `pet-visual-event` 成熟通道与 9 套精灵动画（`PetWindow.tsx:291-359`、`appSharedData.ts:21-31`）。
- journal 持久化 + `resume_of` 续跑链 + `verification_of` 只读核对（`agent_journal.rs`、`agent.rs:535-605`）。
- 写前 hash 检查点 + 读回验收（`file-operations.mjs:44-74`）与授权 epoch 撤销（`agent_operations.rs`）。
- 原生通知桥（macOS FFI）+ 自适应提醒调度器 + soul 主动消息 ledger。
- `data_snapshot` 冻结门/事务/回滚基建（`data_gate.rs`、`data_snapshot.rs:553-591`）。

## 4. 技术方案

### 4.1 协议 v2

`PROTOCOL_VERSION` 升为 2（`agent_protocol.rs` 单一所有者，重新生成 `wire-schema.mjs`），两端同版发布、保持硬校验。新增：

| 事件 | 载荷 | 用途 |
| --- | --- | --- |
| `contract-proposed` | 契约 JSON（目标、里程碑、验收命令、档位、预算） | 触发契约确认卡片 |
| `plan` | 里程碑列表（确认后的最终版） | UI 时间线初始化 |
| `milestone` | `{ id, status: started/completed/failed/skipped, note }` | 时间线推进 |
| `notice` | `{ level: info/warn, text }` | 黄旗上报（"我装了依赖，因为…"） |
| `usage` | `{ inputTokens, outputTokens, elapsedMs, milestoneId }` | 预算遥测 |
| `receipt` | 里程碑状态、改动文件与 diffstat、验收结果、黄旗列表、分支与提交区间、遗留疑问 | 回执卡片 |

新增命令：`agent_confirm_contract`（携带用户编辑后的契约与档位）。`steer` 增加 `mode: "guidance" | "redirect"` 字段。

### 4.2 编排器（sidecar 任务模式）

编排循环写在 sidecar（`sidecar.mjs` 新增 task 分支），**循环逻辑是代码，不是模型**；模型只负责单步决策：

```
start(task):
  1. 无契约 → 注入契约生成 prompt（要求结构化 JSON 输出）→ emit contract-proposed → 等待 agent_confirm_contract
  2. git 安全网（编排器直接执行 git CLI，不走模型）：
     项目是 git 仓库 → 从 HEAD 开 work branch（piko/task-<短码>）
     工作区 dirty → 契约卡片警告，用户选：stash / 仅提交任务触碰文件 / 不启用 git
  3. 逐里程碑：
     emit milestone(started) → session.prompt(执行该里程碑 + 更新任务日志)
     verify = runVerify(project.verifyCommand)        // child_process 直跑，超时/输出截断
     verify.ok → git add（仅任务触碰文件）+ commit → emit milestone(completed)
     verify 失败 → 注入结构化报错自诊断重试（≤2 次，消耗预算）；仍失败 → 挂起或按契约跳过
  4. 预算耗尽或连续失败 → 优雅收尾：提交当前进度 + receipt(status=suspended)
  5. emit receipt → terminal completed
```

关键取舍：

- **验收命令由编排器代码执行**（`execFile`，cwd=workspace，单次上限可配），模型无法跳过或伪造验收。这是方向锚定的核心。
- git 同理由编排器直接执行（不引入 git2 依赖，调用系统 git CLI）；非 git 仓库自动降级为无安全网模式并在回执注明。
- 里程碑执行内部沿用现有 `session.prompt()` 工具循环与 steering 排空（`sidecar.mjs:146-152`），`guidance` 类插话在里程碑边界注入，`redirect` 立即注入。
- 任务日志 `.piko/task-<id>.md` 由模型在 prompt 内更新（写入工作区，受现有检查点保护），编排器在每次里程碑后将其摘要注入上下文——它同时是压缩后的记忆骨架（见 4.5）。

### 4.3 任务级自主权策略

`start` 输入新增 `policy` 字段，替代"逐操作审批"作为默认交互；现有 `ApprovalGate`/`FileOperations` 检查点全部保留，只是触发条件收窄到红项：

| 级别 | 覆盖 | 默认档行为 |
| --- | --- | --- |
| 🟢 自动 | 工作区内 read/write/edit；跑验收命令 | 直接执行（沿用写前检查点 + 读回验收） |
| 🟡 自动 + notice | 安装依赖、计划外新增文件、创建/删除分支 | 执行，同时发 `notice` 事件 |
| 🔴 确认 | shell 命令、工作区外写入、批量删除、`git push`、网络发布 | 走现有审批卡片 |
| ⛔ 拒绝 | 系统目录写入等 | 沿用现有拒绝路径 |

- 三档预设：谨慎（全部确认 ≈ 现状）/ 标准（上表）/ 信任（shell 也自动 ≈ 现有 `agent_auto_approve_commands` 的任务级化）。默认标准，可按项目记忆。
- shell 内容无法静态可靠分类，`🔴 确认` 是默认而非启发式保底；sidecar 仅对高危前缀（`rm -rf`、`git push --force`、写系统路径等）做**尽力而为**的强制升级，文档明示局限。
- `agent_auto_approve_commands` 全局开关保留，语义变为"所有任务默认信任档"。
- 收紧项：`agent_approve` 校验 approvalId 属于该任务 pending 集合（修 H7）。

### 4.4 超时与预算治理

- idle 超时改为**活性超时**：仅在"无工具运行 && 无审批等待 && 无契约等待 && 无 steering 处理"时计数；工具运行单列上限（默认 20 分钟/命令，可配）。
- 任务总时限改为**预算**：`timeBudget`（默认 90 分钟）+ `tokenBudget`（可选），契约中可见，耗尽走优雅收尾而非 failed。
- ApprovalGate 超时可配置（委托任务默认 30 分钟）；审批等待计入"等待用户"而非任务预算之外的时间仍计入总预算，回执中单列。
- journal 步骤上限 256 → 2048，超出滚动归档到 `steps-archive` 文件（修 R13/H8：fsync 改为批量节流）。

### 4.5 提示词分域、上下文与模型配置

- `start` 新增 `taskKind: "coding" | "companion"`（默认 companion，现有行为完全不变）：
  - coding：不注入"统一聊天助手"人格段（`sdk-adapter.mjs:90`）、Rust 伴侣与业务工具规则（`chat.rs:49-85`）；`execution.mjs:14` 的纠正提示去掉业务规则分支。
  - coding 专用系统提示要素：契约与日志位置、里程碑纪律、验收纪律、黄旗上报义务、工作区边界。
- 上下文：项目可配 `contextWindow`（取消 32000 回退，按模型目录取真实窗口）；压缩沿用 SDK 自动 compaction，任务日志 + 契约摘要在压缩后由编排器重新注入，作为记忆骨架。
- 模型：coding 任务 `reasoning`/`thinkingLevel` 开启（项目级配置，按模型能力回退）；SDK `retry` 开启（指数退避，2 次，修 R10）。
- usage 采集：在 sidecar 事件转发处从 SDK 会话消息取用量，无则按 delta 估算，发 `usage` 事件。

### 4.6 项目概念与持久化

- 宿主新增项目注册表 `projects.json`：`{ id, name, path, verifyCommand, policy, modelOverride, contextWindow, lastOpenedAt }`；命令 `project_list/create/update/delete`。
- `ChatContextMenu` 的"选择工作目录"升级为项目切换器（最近项目 + 新建项目）；`agent_start` 携带 `projectId`，验收命令与档位默认取项目配置。
- 任务注册表持久化：journal 已存每任务元数据，扩展 `pending_contract`（契约等待中）状态；启动时对 interrupted 的 coding 任务提供**一键续跑**（沿用 `resume_of` + 检查点，不再要求手动核对）。
- 崩溃恢复：sidecar stdout EOF 时采集退出码；coding 任务可按项目配置自动续跑一次（检查点防止重复写入）。

### 4.7 宠物与通知接线

- 宿主在任务状态迁移处（started / milestone / approval-pending / receipt / failed）发 `pet-visual-event`，`PetWindow` 映射到现成的 `working/confirming/success/error` 模式。
- `ambient.rs` 的 `is_busy` 计入 `AgentRuntime::activity()`，长任务期间宠物不再误入 resting。
- 待审批与任务完成 → `notifications::send`（尊重 quiet_mode）；soul 快照的 `agent_busy/awaiting_confirmation` 字段接真数据（`proactiveBridge.ts` + `commands.rs` 放行只读快照）。
- 里程碑完成 → 宠物冒泡一句话（soul 主动消息通道，`notice` 级别节流）。

### 4.8 前端改造点

- **契约卡片**：复用 `ActionConfirmationCard` 模式，展示里程碑（可增删改）、验收命令（可编辑）、档位与预算选择。
- **里程碑时间线**：`AgentActivity` 升级为时间线视图（里程碑分组，工具流水折叠在里程碑下）。
- **转向**：steering 队列化（修 F2 静默丢弃）；输入区分"补充（guidance）/转向（redirect）"；任务日志查看与批注入口。
- **回执卡片**：`TaskOutcome` 升级——里程碑状态、diffstat、验收结果、黄旗、提交区间；动作：在编辑器打开（`code path:line`）、接受、打回（附反馈自动 `resume_of` + 注入）、丢弃分支。completed 任务显示诊断（修 F5）。
- **排队**：busy 时允许创建排队任务（同会话仍串行执行，显示队列）。

## 5. 问题 → 对策映射

| 现状问题 | 对策 | 阶段 |
| --- | --- | --- |
| R1 单 prompt 无编排 / R9 协议无里程碑 | 协议 v2 + sidecar 编排器 | P0 |
| R2/R3/R4 超时杀死长任务 | 活性超时 + 预算制 + 审批超时可配 | P0 |
| R13 journal 上限 / H8 fsync 放大 | 2048 上限 + 滚动归档 + 节流 | P0 |
| R11 人格污染 / R14 思考关闭 / R10 无重试 | taskKind 分域 + thinking 开启 + SDK retry | P0 |
| R8 上下文过小 | 项目级 contextWindow + 压缩后日志重注入 | P0 |
| R5/R6 逐操作审批与 steer 吊销 | 任务级 policy + guidance/redirect 分级 | P1 |
| R12 选目录停摆 / 续跑禁 shell | 项目绑定预选目录；续跑恢复 shell（检查点仍在） | P1 |
| H4/H1/H2/H3 无 git、无注册表、崩溃弃置 | 编排器 git 安全网 + journal 扩展 + 自动续跑 | P1/P2 |
| H6/F7/F8 无通知、宠物零关联 | pet-visual-event + notifications + activity() 接线 | P1 |
| F1/F4/F5/F10 无时间线回执契约 | 时间线 + 回执卡片 + 契约卡片 | P0/P1 |
| F2/F3 插话丢弃、无排队 | steering 队列 + 任务排队 | P2 |
| F6 无项目概念 / F9 快照即弃 | 项目注册表 + 快照持久化评估 | P1/P2 |
| H5 并发与全局锁 / H9 定时委托 | 锁粒度评估（P2）、reminder→task 桥（P2） | P2 |

## 6. 分阶段落地计划

| 阶段 | 内容 | 验收标准 |
| --- | --- | --- |
| P0 编排核心 | 协议 v2；契约生成与确认；里程碑循环 + 验收命令；活性超时/预算；journal 扩容；taskKind 分域；SDK retry；usage 事件 | 一个 ≥10 里程碑的真实任务不被超时/上限杀死；验收失败能注入报错自愈重试；companion 任务行为与现状零差异 |
| P1 安全网与接线 | 任务级 policy 三档；git 分支/里程碑提交/回执；回执卡片与打回；宠物/通知接线；项目注册表与切换器；guidance/redirect | 无人值守完成小功能：分支可整体丢弃；审批等待有系统通知与宠物反应；插话不再吊销授权 |
| P2 体验深化 | steering 队列 + 日志批注；崩溃自动续跑 + 启动一键续跑；reminder→task 定时委托；压缩调优；排队；锁粒度评估 | 断电/崩溃后一键恢复；"明早 9 点跑测试并总结"可表达；双任务不互相饿死 |

依赖关系：P0 的协议 v2 是其余一切的前置；P1 的 policy 依赖 P0 的编排器（策略在编排层裁决）；git 安全网依赖 P1 的 policy（提交属绿项）。

## 7. 风险与开放问题

| 风险 | 对策 |
| --- | --- |
| shell 自动批准的安全边界（启发式拦截不可靠） | 默认 🔴 确认；git 安全网使后果可整体丢弃；信任档位显式开启并记录 |
| 契约质量依赖模型能力 | 契约完全可编辑；里程碑可增删；验收命令由用户最终把关 |
| 验收命令误报/长耗时阻塞 | 项目级配置 + 单次超时上限 + 失败重试消耗预算 |
| 协议两端漂移 | 沿用 `agent_protocol.rs` 单一所有者生成 `wire-schema.mjs` 的既有机制，CI 校验 |
| 长任务 token 成本失控 | usage 遥测 + tokenBudget 硬顶 + 回执单列成本 |
| 压缩丢失契约记忆 | 任务日志 + 契约摘要压缩后重注入；编码任务日志常驻系统提示尾部 |

开放问题（P2 前观察，不阻塞 P0/P1）：

1. 里程碑方向漂移是否需要第二个"评审模型"复核（除验收命令外的软检查）。
2. 系统工具全局互斥锁的公平调度（当前一任务占锁即阻塞他任务，`agent.rs:51`）。
3. Passport 设备端是否展示任务状态（专注同步已通，可复用 `publish_device_pet`）。
4. 快照是否持久化到磁盘（当前内存 64 组，重启靠 journal；若时间线回放需求强则升级）。

## 8. 交付状态（2026-10-31）

P0、P1、P2 已全部落地（契约见 [doc/design/18](../design/18-delegated-task-protocol.md)），全套验证通过：vitest 408、agent 101、cargo 434、e2e 145。

开放问题 2 的评估结论：**不收窄全局系统工具锁**。该锁除 workspace 互斥外还兜底 shell 越界命令与全局缓存（npm/brew 等）的并发冲突；workspace 前缀互斥在准入时已保证目录不重叠，收窄只惠及 `MAX_PARALLEL_TASKS=2` 下的一对任务，却引入 symlink 假并行、运行中切换目录等风险。若未来要落地，建议 sidecar 在 acquire 时声明工具类别与目标路径，宿主对纯工作区内文件工具按 canonical 路径键控、shell 一律全局锁。

遗留边界（可接受，出现需求再升级）：

- `agent_read_task_log` 依赖内存快照定位 workspace，应用重启后无法读取旧任务日志（需把 workspace 持久化进 journal）。
- "重新发起"依赖内存快照的 prompt/cwd，重启后降级为提示（journal 按设计不复制 prompt）。
- 定时任务到期遇配额/目录占用时优雅失败，无排队重试。
- 高危命令拦截为尽力而为启发式；Windows 系统路径未覆盖。
