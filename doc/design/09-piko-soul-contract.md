# 灵魂系统接口与存储契约

对应 S00/S01/S02。本文固定实现契约；后续调度、话题和聊天接入按任务依赖推进，不代表 P0 已交付。

## 已实现的底座

- Rust DTO：`memory/soul/model.rs`；TypeScript 对应：`src/features/soul/types.ts`。序列化采用 snake_case，时间为 Unix 秒，时区为 IANA 标识；revision 从 1 开始，expected_revision=0 仅用于创建。
- 使用现有 `memory.db`，灵魂表统一 `soul_` 前缀，独立 `soul_schema` 版本，不改动现有记忆迁移和 `user_version`。
- 初始 schema 包含角色、候选/版本、话题、账本、额度/暂停/退避、情绪和共同历史表。后续阶段目前仅保留表，无触发源和调度行为。
- 迁移在单个事务完成；失败保留原数据并记录错误，普通 Agent/记忆不切换为临时数据库。现有记忆自身失败后的临时数据库不初始化灵魂表。
- 写入必须通过事务；profile 使用 compare-and-swap，提交成功后才返回新 revision。缺失配置、配置结构损坏、数据库不可用分别返回，不把存储错误解释为“空账本”。
- 核心常量在 Rust model 定义；SQL 活动项上限从同一常量展开。UI 后续读取后端有效策略，不复制阈值。

## 命令与事件名称

| 接口 | 用途 |
| --- | --- |
| `soul_get_profile` / `soul_update_profile` / `soul_reset_profile` | 角色读取、带 expected_revision 的修改、恢复 |
| `soul_get_settings` / `soul_update_settings` | 后端策略与开关；返回未交付能力状态 |
| `soul_list_open_loops` / `soul_review_candidate` / `soul_update_open_loop` | 审核与生命周期管理 |
| `soul_report_activity` | UI 活动快照，缺失/过时字段阻止投递 |
| `soul_ack_message` | 携带消息 ID、回应/关闭/真实可见回执 |
| `soul_clear` / `soul_diagnostics` | 分项清理与本地诊断 |
| `soul:message` / `soul:revoke` / `soul:changed` | 消息投递、撤销及已提交状态更新 |

角色读取/更新/恢复命令及 `soul_diagnostics` 已注册；`soul:changed` 在角色提交后发出 revision。其余名称为后续任务保留，当前不启用。命令 DTO 与返回类型在 Rust/TypeScript 一一对应；设置更新只接受可写开关，`available`、上限和启用基准等由后端决定，不信任客户端传值。

## 状态与调度约束

| 当前状态 | 允许后继 | 条件 |
| --- | --- | --- |
| pending | dispatching / expired / revoked | 所有门控通过并事务占用额度，或过期/关闭 |
| dispatching | shown / failed / uncertain / revoked | 真实可见回执、投递失败、重启不明、关闭 |
| shown | responded / dismissed / ignored / revoked | 明确回应、手动关闭、连续可见 20 秒无回应、关闭 |
| responded / dismissed / ignored / revoked / expired / failed / uncertain | 无 | 终态不重新入队，迟到回执不能复活 |

`pending → dispatching → shown → responded/dismissed/ignored`；pending 可过期或撤销，dispatching 可失败、撤销或变为 uncertain。重启后未确认的 dispatching 只转 uncertain，不回 pending、不伪造 shown。展示前，同一事务占用账本去重键和额度；失败不返还已占用额度。来源删除或版本改变撤销旧版本消息。

话题为 `pending_review → tracking → due → closed/cancelled/expired`；未排期话题保持 tracking，回访调度 P1 才启用。批准候选和新增话题必须同事务；tracking/due 合计上限由数据库约束。候选拒绝后保留来源去重信息，不能靠重新提取复活。

额度仅使用一个持久化全局桶，而非按时区新建桶。日桶标识使用持久化 local_date，必须严格递增。换日须同时满足本地自然日向前以及持久化 reset_not_before；基于上次授额时刻设置不少于 24 小时的保护，回拨时不降低 high_water_at。跨时区可保守延后，不能增加额度。进程内冷却使用单调时钟。重启若存在历史投递，保守设置进程内 2 小时冷却；同时检查持久化 last_dispatch_at，墙钟早于 last_dispatch_at 时也不允许投递。每日额度不因启动、切换时区或系统时间回拨而重新建桶。写盘失败不更新进程内桶或冷却基线。高水位仅向前，换日后 reset_not_before=当前高水位+24 小时。此策略允许跨时区/重启时延后，优先避免额外额度。

| 类别 / 优先级 | 来源 / 去重身份 | 开关及有效期 |
| --- | --- | --- |
| task_unresolved / 1 | 任务 ID；同一任务只提醒一次，关联重试不能重新获得机会 | P0 验收前禁用；之后默认开；终态后次日当地 09:00 起 7 天 |
| open_loop / 2 | 话题 ID + 已确认 revision | 默认关，P1；已确认时间区间对应的 7 天窗口 |
| greeting / 3 | 启动/返回事件 ID | 默认关；启动/返回后 30 分钟，关闭期间不补发 |
| milestone / 4 | 唯一里程碑键 | 默认关，P1；解锁后 24 小时 |
| pattern / 5 | 已确认记忆 ID + revision + 观察周期 | 默认关，P1；可信事实触发后 2 小时 |
| small_talk / 6 | 本地模板触发事件 ID | 默认关，P1；本地触发后 2 小时 |
| output_feedback / 7 | 可信产出事件 ID | 默认关，P2；可信产出事件后 2 小时 |

所有候选必须明确 valid_from/expires_at，过期不补发。valid_from 等价于设计中的 not_before。优先级、类别额度和有效期由 Rust ProactiveCategory 提供，UI 不复制策略常量。每任务一次另有任务 ID 唯一投递身份，不能因 source revision 或重试而重置；普通类别以 category/source_id/source_revision 去重。话题同一 revision 只产生一次候选；经审核延期后以新 revision 固定新的时间窗，仍须检查每话题 7 天频控，禁止通过重复扫描制造新周期。

问候源为进程启动 UUID 或带时间的 idle→active 事件；模式观察源必须是已审核记忆及可核验时间字段；小话源为本地触发 UUID；产出评价源为预览/收藏的显式事件。模式观察规则和停留阈值属于 S18/S21；尚未满足证据规则的事件不生成候选。

活动信号接入点：quiet_mode 来自后端设置，minimal 一律阻止，active/balanced 仍遵守其余门控；静默时段与既有配置取更严格限制。输入来自 typing_activity 和聊天 UI 输入/焦点事件；Agent 执行与等待确认由后端业务状态决定，UI 不可覆盖。精灵可见与气泡回执来自对应窗口，并由窗口标签校验来源。

OS 空闲复用现有 idle 检测的系统采样，不能用 UI 的累计输入统计或“当前前台应用”替代。系统锁屏须由平台适配提供可信状态；不能可靠读取的系统保持 unknown。S07 接入平台 API；未知状态保守阻止投递。UI 每 5 秒报告活动心跳，后端记录接收单调时间，超过 10 秒无心跳判定为未知，不接受 UI 声称的未来 observed_at。空闲→活跃稳定 30 秒后检查，其间任何抑制条件重置稳定计时。

门控优先级：存储/功能未交付 → 全局关闭 → 显式暂停 → 类别关闭 → quiet_mode/静默时段 → 活动未知/锁屏/空闲/输入/Agent 执行或待确认/精灵隐藏 → 稳定活动 → 来源有效性 → 时间窗 → 去重、日额度与冷却。前面的关闭/暂停条件即时撤销队列和可见主动气泡；恢复只处理启用基准之后的新事件，不补发关闭期间内容。权限确认与独立日程提醒不经过此链。显式恢复暂停时同样更新启用基准，暂停期间事件不补发。

展示回执只接受气泡窗口对当前消息身份的报告；后端以单调时钟记录 shown/hidden，不能把 UI 自报的累计秒数直接当作忽略证据。连续可见计时在 hidden 后归零；只有 shown 且连续可见满 20 秒、未回应时才可 ignored。系统通知和气泡使用同一消息 ID，通知成功本身不算气泡 shown。

独立日程提醒、普通聊天和权限确认继续使用现有通道，不写入灵魂账本、不消耗额度。消息点击/回应只携带来源进入普通聊天，不授权重跑，不将模板升格为系统指令。

## 角色存储与恢复

默认角色复用三个 `src/locales` 资源，schema/resource 版本独立维护。有效值按默认 → 已确认演化 → 用户覆盖合成；空字符串/空列表是显式覆盖，缺少字段才继承。语言变化只切换默认资源，不重写用户值或 revision。

首次读取创建 revision=1 的空覆盖。编辑替换用户覆盖层，校验字段名、长度及结构，CAS 校验 expected_revision。恢复清除用户覆盖；clear_evolution_history=false 清除当前覆盖及演化、保留历史版本，true 同时原子清理历史版本和演化候选。配置损坏时可读默认角色但禁止普通编辑；显式选择清理演化历史的恢复可修复损坏记录，仍校验真实 revision。P0 没有演化候选生产器或写入入口。

默认资源损坏由打包资源测试阻止发布；运行时配置异常不写回资源。启动迁移结果保存在独立内存状态，不能仅凭版本号推断迁移成功。临时数据库不可写灵魂状态。设置页诊断仅返回状态/版本/错误码，不输出正文、路径或 SQL 错误副本。账本与额度读取异常阻止投递，不清空或修复为零额度。

## 会话快照接入（S03 已实施）

普通聊天在请求开始、Agent 在任务开始各读取一次 RoleSnapshot；system_prompt 接受该不可变快照。工具续轮和只读核对都继承同一快照。下一请求才读取新 revision。sidecar 当前一任务一进程，即使恢复相同 SessionManager 记录，也会根据本轮输入重新创建 ResourceLoader 和 AgentSession，使用新系统 prompt 与模型配置；工具续轮保持该任务的快照。无需在 sidecar 另读配置或修改 Pi 协议。角色内容作为 JSON 资料块，权限/安全/只读要求及用户当前轮语气要求始终优先；不得让自由补充成为可执行系统规则。

## 后续接入

S04/S05 接入候选和话题；S06–S09 按本文实现调度、活动和回执。S10 接入角色编辑 UI。当前角色已进入普通聊天与 Agent prompt，尚未开启主动消息。后续调度在启动及投递占用前须通过 check_ledger，不得将账本/额度异常解释为空数据。



## 最终实现补充（2026-10-17）

- 存储迁移现为 v4；后续阶段的表和命令已接线，不能再把它们描述为仅预留。
- 分类开启及清理维护持久化分类基准；全局和分类基准均约束事件来源时间。清理不返还已消费的全局/分类额度，保留非内容冷却凭据。
- 共同历史、称呼、演化审核/回退命令见 `continuity.rs`；话题回应候选见 `engagement.rs`；本地观察和预览计时见 `observations.rs`。
- 预览阈值固定为连续 60 秒，原生窗口需可见且获得焦点，五秒报告一次，超过十秒缺心跳重新计时；内嵌预览至少 50% 交叉可见。模型不能上报这些证据。
- 日程草稿建议阈值固定为重叠、批量总时长 >8 小时或 >6 项，仅附加提示，不阻止权限门或执行。
- 任务通知只在 macOS 使用共用身份的原生适配；权限仅由设置中的显式动作申请。投递不请求、不重试权限，非 Soul 通知转交原通知代理。
- 演化为有限预设，三不同会话明确证据、每字段七天频控、拒绝去重、最近五十个版本。回退保留手动覆盖并暂停字段，明确关闭再开启才恢复提议。
- 完整证据和环境限制见 [最终验收记录](../validation/09-piko-soul-final-acceptance.md)，用户操作见 [使用说明](09-piko-soul-user-guide.md)。
