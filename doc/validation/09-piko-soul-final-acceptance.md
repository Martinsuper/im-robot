# Piko Soul 最终验收记录（2026-10-17）

## 当前结论

S00–S23 涉及的实现均已落地。功能验证采用确定性测试、真实模型合成场景和独立 macOS 应用测试，不能混称为同一种验证。

**S00–S23 共 24 项已全部签收。** 最后一项真实 macOS 通知正文点击于 2026-10-17 22:17:23 完成：通知中心收到同一通知的 contents response，前台打开隔离应用；原生界面保留同一任务来源，点击前后执行记录哈希不变。临时专注模式例外及隔离通知权限均已恢复，正式 Piko 数据未改动。

后文按时间保留排查过程中的待验收状态和推断更正，最终结果以本节和文末“最终点击签收”记录为准。

## 自动检查

- Rust：2026-10-18 最终源码完整检查 251 通过、1 忽略；Soul 子集此前 100/100 通过。忽略项为显式导出合成模型提示词的辅助测试，不是未通过的产品用例。
- 前端：31 个文件、220 项通过（加入窗口就绪恢复竞态回归后）。
- Agent 权限与会话回归：20 项通过（`/tmp/soul-final-agent-checks.log`）。
- TypeScript：`npx tsc --noEmit` 通过。
- 目标文件 ESLint：零错误、零警告。
- `git diff --check` 通过。
- 隔离 macOS `.app` 构建通过；最终构建使用独立应用标识和独立用户数据目录。

主要日志：`/tmp/soul-final-suite.log`、`/tmp/soul-final-front.log`、`/tmp/soul-final-types.log`、`/tmp/soul-final-eslint.log`。最后的原生构建及回归日志为 `/tmp/soul-delivery-final-build.log`、`/tmp/soul-delivery-final-tests.log`。

## 验收矩阵

| 项目 | 证据与结果 |
| --- | --- |
| 迁移及存储故障 | 新库、逐版迁移、幂等、未来版本拒绝、事务失败回滚通过；原生隔离库从 v3 升至 v4 |
| 人格编辑和快照 | 原生保存 revision 1→2；跨 provider、轮内固定、用户覆盖与权限优先的测试通过 |
| 时间与话题 | IANA 时区、纽约春秋 DST、源基准和模糊时间测试通过；原生回应审核使话题 revision 1→2、state=closed |
| 回应审核边界 | 完成/取消/明确改期只产生候选；还没不变；含糊或多话题先澄清；旧 revision 不覆盖；拒绝不复活 |
| 活动与静默 | 原生宠物心跳、macOS 锁屏采样和实际任务气泡验证；未知信号 fail closed；真实最近输入代替非空草稿 |
| 回执及退避 | 原生 shown→responded；原生连续可见后 ignored、visible_seconds=20 且提醒条消失；隐藏、重复、提交失败、三次忽略/七天/回应恢复测试通过 |
| 任务闭环与恢复 | 次日当地 09:00、任务链根去重、显式解决、完成/取消撤回、重启 uncertain 与历史投递冷却接线通过 |
| 清理和来源 | 分项/全部/分类清理、会话和消息 ID 联动、删除墓碑、保留期测试通过；清理保留已消费额度和冷却元数据 |
| 情绪 | 默认关闭、开启新基准、重复开启保留新状态、关闭清零；原生开关 revision 1→2→3 和快照清零；业务/互动优先及动画回退测试通过 |
| 共同历史与称呼 | 真实提交事件、去重、自然日、清理测试通过；原生默认不选称呼，手动选择后保存 partner；不引入能力门槛 |
| 本地模式/小话 | 默认关闭、已确认日期事实、本地模板、独立开关、共用额度；不调用模型、不推断健康心理 |
| 演化与回退 | 三个不同会话明确证据、每字段七天频控、拒绝去重、50 版本上限、事务回滚测试；原生批准版本 2→3、回退创建版本 4，用户覆盖保留且字段暂停 |
| 产出观察 | 原生独立 HTML 预览持续前台后 observed_at 写入、evidence_kind=viewed，账本生成 output_html_viewed；缺心跳、隐藏、来源删除不算有效停留 |
| 评价与日程建议 | 只用可证实的“已连续显示/已收藏”本地文案；重叠、批量总时长 >8 小时、>6 项的建议只附加确认草稿，不绕过权限 |
| 权限及 Agent 回归 | 既有权限、只读核对、普通提醒及日程测试通过；通知代理转交不属于 Soul 的通知给原代理 |
| 通知未授权 | 只查询权限，不在投递时请求、不重试；用户可显式点击设置中的授权按钮；授权后的真实 OS 点击待用户允许验收 |

## 真实模型

最终角色边界重新导出后，gpt-6-luna 与 deepseek-flash 各运行聊天、语气纠正、失败收尾、只读核对、权限请求、恶意角色数据六个合成场景，12/12 自动检查通过。

结果 `/tmp/soul-final-models.json`：synthetic_only=true、tools_executed=false。未发送真实聊天，未执行模型工具。此前人工审读确认失败不等于无副作用、只读不能删除、角色不能改权限。模型结果不要求逐字一致。

## 隔离原生证据

测试标识 `com.duanluyao.piko.soulacceptance`，数据目录包含 `.soul-acceptance-fixture`。没有改正式 Piko 数据。最后的演化/话题验收输入由带标记的合成夹具提供，只证明真实命令和界面接线；三会话证据提取门槛另外由测试验证，不能把手工夹具当作提取证据。

- 演化批准后 profile revision=3；回退后 revision=4、confirmed_evolution={}，user_overrides.tone 保留；暂停字段为 tone、catchphrases。
- 选择后 nickname=partner；选择之前为 NULL，不自动改称呼。
- 话题审核后 revision=2、state=closed，候选 approved，memory_items 仍为 0。
- 原生预览令牌 64815-2 获得前台焦点并保持连续可见后，记录 viewed，生成 pending 的本地模板候选。重启冷却保留，未绕过投递额度强制展示。
- 隔离配置内 API 凭据副本不存在。测试程序在不需要交互时退出。

## 明确的实现范围

1. 当前系统通知适配为 macOS；其他平台保守使用气泡。用户已明确允许合成通知；真实 OS 通知中心正文点击已于 22:17:23 验证。
2. 当前仓库没有 Cubism 渲染器；现有 Lumi/自定义形象使用已有表情，经典形象缺少对应情绪动画时回退原动画。没有声称实现不存在的渲染器。
3. 没有陪练模式的可信“已开启”事件，因此不把“开始陪练”请求伪造为成功事件；energized 规则/表现保留，但不凭空自动触发。
4. 模式观察只支持已审核计划的可验证日期分布；演化只支持明确的有限语气/口头禅预设，不做任意心理或价值观推断。
5. HTML 预览需要原生前台焦点、可见心跳和 60 秒连续区间；内嵌预览要求至少 50% 交叉可见。停留不是阅读、更不是满意或质量认可。
6. 保留期：候选及账本正文细节 30 天、终态话题 90 天、情绪事件 24 小时、演化最小证据 90 天、角色最近 50 个版本。去重墓碑和非内容额度/冷却凭据保守保留，防止清理或调时获得额外消息。


## 最后待确认动作

最终隔离构建已再次成功，设置页已实际显示“授权任务系统通知”按钮，尚未点击，也没有申请或授予新系统权限。全局主动消息在隔离配置中关闭，凭据副本不存在；之前的合成验收库已备份到 `/tmp/soul-native-acceptance-backup.db`。用户随后已允许仅合成通知。最新授权、投递与清理结果见下方补充记录。

新增通知代理保留原通知代理并转交非 Soul 通知；账本校验已接入启动和每次调度，损坏时停止主动投递。最终检查日志补充：`/tmp/soul-closed-final.log`、`/tmp/soul-final-review-front.log`、`/tmp/soul-final-review-types.log`、`/tmp/soul-final-review-eslint.log`、`/tmp/soul-final-chat-eslint.log`、`/tmp/soul-final-reviewable-build.log`。


## 已授权合成通知验收补充（2026-10-17）

- 用户明确授权“允许，仅验收合成通知”，无需再次申请同一动作的许可。仅操作 `com.duanluyao.piko.soulacceptance`，未改变正式 Piko 通知设置。
- 隔离构建最初只有链接器临时签名；以独立 bundle identifier 对整个验收包重新进行 ad-hoc 签名后，系统设置出现独立的 Piko Soul Acceptance 通知条目。UI 开启允许通知得到 on 状态。
- 使用同一条合成消息 `notification-acceptance`，source 为 `agent_task / 11111111-1111-4111-8111-111111111111 / revision 1`。系统日志确认 request identifier `piko-soul:notification-acceptance` 已 Delivering / Presenting as banner；这只证明系统投递，不能代替真实点击验证。日志：`/tmp/soul-native-notification-system.log`。
- 首次横幅未及时捕获即撤回；后续同一消息的隔离重试中，原生自动化读取通知中心反复 `timeoutReached`。最后一轮气泡截图为空白、账本停留 dispatching，尚未完成原生端到端验证，不能将此结果记为全部通过。重试仅重置带验收 marker 的合成库，未改产品门控或退还真实用户额度。
- 检查中修正两处锁顺序风险：Objective-C 通知来源校验/点击回调放到后台队列，避免主线程等待 SQLite；调度器在取得数据库锁之前查询气泡可见性。采样未证明当次进程发生死锁，因此此处记录为风险修复，不将空白界面归因为已证实的死锁。
- 最新独立 app 构建成功；上述修改后的 Soul Rust 回归 99/99 通过，日志 `/tmp/soul-notification-final-build.log`、`/tmp/soul-notification-final-tests.log`。此前完整 Rust/前端/Agent 检查仍见上文。
- 收尾：退出验收应用，合成库全局主动消息关闭，未终结消息撤回；恢复隔离通知为临时样式并关闭其系统通知权限。隔离目录无 `api-credentials.json`。正式应用数据未触碰。
- 当前剩余工作仍是修复/排除最终构建原生空白状态并完成真正的系统通知点击、同源账本与无额外执行核验；S12/S19/S23 不勾选最终签收。


## 气泡就绪恢复补充（2026-10-17）

- 再次冷启动并通过原生菜单打开对话，气泡内容正常加载；此前空白未稳定复现，因此仍不宣称已证明其根因。
- 修复已确认的消息交付缺口：前端监听注册前发出的 `soul:message` 可能丢失。新增仅限 bubble 窗口的 `soul_current_message`，在两个监听完成注册后从账本读取仍有效的 dispatching/shown 消息；保持原始消息和来源 ID，不重新占用额度、不执行任务。读取执行账本完整性校验，并遵守全局关闭、暂停与到期限制。
- 前端恢复期间收到的新消息优先；收到撤回的活跃 ID 集合后，旧恢复结果不能重新显示已撤回消息。
- 新增前端冷启动恢复/无任务启动与恢复期间撤回竞态回归；后端覆盖身份保持、状态不改变、到期、暂停和关闭。Soul 后端 100/100；前端 31 文件 220/220；TypeScript、目标 ESLint 通过。日志 `/tmp/soul-recovery-rust.log`、`/tmp/soul-recovery-all-front.log`、`/tmp/soul-recovery-types.log`、`/tmp/soul-recovery-eslint.log`。
- 修复后的隔离 app 构建成功并正常打开气泡。合成消息复验仍为 pending，系统多次采样空闲时间仅 1–3 秒，符合最近输入抑制的可能条件；不绕过原有活动门控。真实 OS 通知点击尚未签收。


本轮收尾：原生合成消息持续停留 pending，未强行跳过活动门控。已退出隔离应用、关闭全局主动投递并撤回待投递合成消息，系统通知样式恢复临时且权限关闭；独立数据目录再次确认无 API 凭据文件。已向用户询问方便暂停输入并点击横幅的验收时机，原有合成通知授权仍有效。最终源代码构建日志为 `/tmp/soul-recovery-final-build.log`，S12/S19/S23 保留未签收。

最终构建成功，验收包已使用独立 identifier 重新进行 ad-hoc 签名；`git diff --check` 通过。没有重新启动或开启主动投递。


## 有效时间基准下的合成投递（2026-10-17 22:05）

用户已表示可以暂停输入并点击通知。首次等待期间，系统空闲时间实测超过 45 秒，候选仍为 pending。随后定位到验收夹具设置错误：预热窗口后更新 enabled_since，但合成候选 created_at 早于该基准，正确触发了“开启后不回放旧消息”的排除规则。此前将 pending 主要归因于持续输入的推断不成立；这里明确更正。产品门控没有放宽。

修正为同一事务中 enabled_since=now-1、候选 created_at=valid_from=now 后，真实调度器正常投递：

- 22:05:16，系统日志确认 `piko-soul:notification-acceptance` Presenting as alert；账本同一 ID 进入 shown，shown_at=1792245916。
- 22:05:46，账本进入 ignored，visible_seconds=20；系统日志确认同一 request 被移除。这次原生气泡已正常显示并发送展示回执，未再出现空白/无回执。
- 来源保持 `agent_task / 11111111-1111-4111-8111-111111111111 / revision 1`；投递前后 `agent/tasks.json` SHA-256 完全相同，未新增任务或工具执行。
- 证据 `/tmp/soul-valid-notification-delivery.log`、`/tmp/soul-valid-notification-evidence.json`、`/tmp/soul-final-click-journal-baseline.json`。
- 尚未获得真实点击的正向证据，已询问用户是否看到/点击过正文；不能用成功投递和自动撤回替代点击验收。S12/S19/S23 继续保留阶段未签收。
- 为 LaunchServices 启动的调试包补充系统门控原因码日志，避免 stderr 被丢弃；只记录固定原因码，不记录聊天、来源内容或 API 凭据，release 构建不调用此日志。
- 本轮已退出隔离应用并关闭其全局主动消息；系统通知恢复临时样式且权限关闭。没有改变正式 Piko 的权限或数据。

固定原因码采用 os_log 显式公开格式，仅在调试构建调用；最终构建成功并重新签名，日志 `/tmp/soul-native-observable-final-build.log`。`git diff --check` 通过。


## 通知中心抑制原因补充

用户说明此前离开屏幕未点击，并请求重试。通知中心日志进一步表明：usernoted 的 Presenting as alert 仅表示交付给通知中心，不足以证明用户屏幕出现横幅。通知中心先记录 interruption suppression=delay；UI 确认“个人”专注模式开启。用户随后明确批准仅将 Piko Soul Acceptance 临时加入允许 App，验收后立即移除，此批准已通过原生 UI 应用，未关闭专注模式或修改其他允许项。

加入临时例外后的 22:13:18 日志明确记录 interruptionSuppression=silence、resolutionReason=display shared。因此不能把之前横幅不可见全部归因于专注模式；屏幕共享静音是已证实的额外条件。未修改“屏幕镜像/共享期间允许通知”的全局设置，避免超出仅合成通知的授权范围。改为让用户打开通知中心后从其中点击合成通知。证据 `/tmp/soul-native-screen-sharing-evidence.log`。实际点击仍需正向证据；临时专注模式例外在验收结束时必须移除。


## 最终点击签收（2026-10-17 22:17:23 +0800）

- 用户确认通知中心已展开后，重发同一条合成候选；没有修改全局共享屏幕通知策略，也没有放宽产品活动门控或频控。
- 22:17:08，request `piko-soul:notification-acceptance` 被通知中心接收；22:17:23.169，系统记录 `Received response`，`response action: contents`、`foreground: true`；22:17:23.170，系统通知客户端 `com.duanluyao.piko.soulacceptance:85422` 处理该 response。日志明确绑定同一 request、同一通知实例 `11CD0A93`。
- 点击后原生窗口为 Piko Quick Chat，任务来源仍为 `agent_task / 11111111-1111-4111-8111-111111111111 / revision 1`，显示中断任务及只读核对入口。账本 ID 始终为 `notification-acceptance`，未创建新消息身份；最终记录状态为 dismissed。
- 点击前后 `agent/tasks.json` SHA-256 完全一致：未新增任务、未执行工具、未自动续跑。证据 `/tmp/soul-final-notification-click.log`、`/tmp/soul-final-notification-click-evidence.json`、`/tmp/soul-final-click-journal-baseline.json`。
- 窗口就绪恢复已通过后端 100 项及前端 220 项回归；TypeScript、目标 ESLint、最终 macOS 构建及 diff 检查通过。此前单次空白未再稳定复现，后续多轮原生显示、展示回执、忽略撤回和本次通知点击均正常；不将其根因夸称为已证实。
- 收尾通过原生设置 UI 移除唯一临时新增的 Piko Soul Acceptance 专注模式允许项，名单回到原有五个 App；未关闭“个人”专注模式。隔离通知样式恢复临时、允许通知切换为 off；隔离全局主动投递关闭，应用退出，隔离目录无 API 凭据文件。正式 Piko 权限及数据未修改。
- S12/S19/S23 已补签；在本文明确的平台、渲染器及真实业务事件范围内，S00–S23 共 24 项全部完成，没有剩余待批准或待点击动作。


## 交付复核（2026-10-18）

最终源码完整 Rust 检查 251 通过、0 失败、1 忽略；前端 31 文件 220 项通过；Agent 权限与会话回归 20 项通过；TypeScript 通过。日志分别为 `/tmp/soul-delivery-rust-20261018.log`、`/tmp/soul-delivery-front-20261018.log`、`/tmp/soul-delivery-agent-20261018.log`、`/tmp/soul-delivery-types-20261018.log`。忽略项仍为显式导出合成提示词的辅助测试。

复核任务清单 24/24；现有 diff 与 40 个相关新增文件的空白检查通过。隔离全局主动消息为 off，API 凭据文件不存在。没有重新开启通知权限或更改系统专注/共享设置。用户指南已补充 macOS 显式通知授权、专注/屏幕共享静音、通知中心同源点击及消息撤回行为。

本次仅补充交付说明和复核记录，未修改功能代码。当前工作区包含 Soul 及其他已有变更，未对这些混合变更执行提交、安装或发布；正式版本交付需按仓库发布流程另行进行。
