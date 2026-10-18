# 草稿确认与业务执行编排拆分验证

日期：2026-10-18

## 完成内容

- 10 个现有定义及实现迁入 actions 模块：草稿与回执 DTO、预览生成、批量选择和确认/拒绝命令。
- 队列锁封装在 actions/store.rs，聊天与 Agent 改用保存、查询副本、一次性消费及任务清理接口。
- Agent 的检查点授权、授权作用域、只读核对和安全续跑仍使用原有实现；批量选择由授权与执行共享。
- 原有三个草稿预览测试随实现迁移，新增三个队列契约测试。

## 验证结果

- 新增测试覆盖查询副本隔离、消费后过期、两个并发确认仅一次成功，以及任务清理不影响其他任务。
- 迁移项的词法核对一致；确认/拒绝命令仅将直接锁操作替换为队列消费接口，其余执行逻辑保持一致。
- 生产 invoke_handler 核对：confirm_chat_action、reject_chat_action 各以 actions::commands 路径注册一次，公开命令名称未变。
- cargo test --manifest-path src-tauri/Cargo.toml --lib：263 通过、1 跳过。
- cargo check --manifest-path src-tauri/Cargo.toml --lib：通过。
- npm run build：通过。
- git diff --check：通过。

本轮没有迁移用户数据、改变确认策略或自动重放操作。验证包含队列并发测试与既有业务回归，未执行操作系统级确认窗口或真实命令写入验收。
