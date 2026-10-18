# 提醒业务服务拆分验证

将 lib.rs 当前启用的 18 个定义迁入 reminder_service/，涵盖 DTO、入参解析、重复规则标签、读写、CRUD、检查点防重放及到期调度。迁移两项到期筛选与重复提醒测试。插件、草稿、检查点、统一日程和导入导出直接引用新模块。

## 契约

- list_reminders / create_reminder / delete_reminder 名称、参数、返回值不变，各注册一次。
- schedule-items.json 继续作为唯一运行数据源，保留视图转换和合并写入；旧提醒迁移路径不变。
- 保留事务锁、错误信息、检查点 ID 与防覆盖/自动重建约束。
- 到期提醒仍先持久化，再发系统通知、宠物事件和面板更新事件。
- 重复计算复用 reminder_schedule，后台等待仍使用存储 revision 与最近到期时间。
- 不启用旧 reminders.rs，不新增依赖、数据迁移或 Soul 事件。

## 验证

- 18 个迁移定义与原始 token 对比一致（忽略可见性、空白与逗号格式）。
- 三个生产 IPC 逐一检查，仅注册一次。
- cargo test --manifest-path src-tauri/Cargo.toml --lib：263 通过，1 跳过。
- cargo check --manifest-path src-tauri/Cargo.toml --lib：通过。
- npm run build：通过。
- git diff --check：通过。

未进行原生系统通知交互或真实用户数据写入测试。测试仅保留既有 memory 模块的两项编译警告。
