# 日历业务服务拆分验证

从 lib.rs 当前编译路径迁移 38 个定义（505 行）到 calendar_service/，涵盖 DTO、通知缓存、入参解析、事件读写、检查点、冲突、批量操作、ICS 和到期处理。迁移 8 项现有测试及其临时路径辅助函数；跨模块的统一日程与动作草稿测试继续保留原测试位置。

## 保持的契约

- list_calendar_events、create_calendar_event、delete_calendar_event、export_calendar_events、open_calendar_import 保留原名称和参数，各注册一次。
- schedule-items.json 仍为运行数据源，视图与合并写入、迁移归档路径不变。
- 事务锁、错误信息、检查点 ID 和防重放约束不变。
- 批量删除在移除前校验全部目标，成功后继续标记同步删除墓碑并发布更新。
- 到期通知缓存、触发窗口与后台等待不变。
- ICS 格式、转义和系统打开命令保持原实现。
- 不新增依赖、数据迁移或 Soul 事件，不启用旧 calendar.rs。

## 验证

- 38 个迁移定义与原始 token 对比一致（忽略可见性、空白及逗号格式）。
- 五个生产 IPC 注册逐一检查通过。
- cargo test --manifest-path src-tauri/Cargo.toml --lib：263 通过，1 跳过。
- cargo check --manifest-path src-tauri/Cargo.toml --lib：通过。
- npm run build：通过。
- git diff --check：通过。

未执行真实日历写入、同步服务交互、系统通知或系统日历导入测试。
