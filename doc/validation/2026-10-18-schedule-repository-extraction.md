# 统一日程仓储拆分验证

从 lib.rs 迁移 11 个定义（112 行）至 schedule/repository.rs 与 schedule/commands.rs。仓储统一管理四种路径、迁移状态、按策略加载、读取和持久化；命令模块承接时间线列表与完成提醒。提醒、日历和 Agent 操作检查点直接引用仓储。

## 保持的契约

- schedule-items.json 是唯一运行数据源；旧文件只参与迁移与只读回退。
- 迁移失败时，读路径允许只读旧文件回退，写路径传播错误。
- 迁移标记检查、迁移幂等、损坏处理、旧文件备份及保留行为不变。
- 事务锁及调用方持锁要求不变；持久化成功后仍广播 schedule-updated。
- list_schedule_items 与 complete_schedule_item 名称、参数、排序、完成状态及错误文案不变，各注册一次。
- 启动迁移、数据清理、导入导出和操作检查点行为不变。
- 不新增依赖或数据迁移。

## 验证

- 11 个迁移定义与原始 token 比对一致（忽略可见性、空白、逗号和类型限定路径）。
- 两个生产 IPC 注册逐一检查通过。
- cargo test --manifest-path src-tauri/Cargo.toml --lib：263 通过，1 跳过，包含已有迁移幂等、损坏中止、备份、旧文件保留与视图往返测试。
- cargo check --manifest-path src-tauri/Cargo.toml --lib：通过。
- npm run build：通过。
- git diff --check：通过。

未执行原生窗口交互、真实用户数据写入或外部日历同步服务测试。
