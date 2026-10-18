# 聊天历史与会话仓储拆分验证

将 lib.rs 当前启用的 17 个定义（179 行）迁入 chat_session 模块。ChatHistoryEntry DTO 归属模型文件；路径、迁移、读取策略、持久化、历史视图和追加逻辑迁入 repository.rs；六个 IPC 迁入 commands.rs。

## 保持的契约

- chat-sessions.json 仍是唯一写入口，旧历史文件的迁移和只读回退行为不变。
- 迁移版本、备份、损坏处理、会话分组及保留策略不变。
- 仓储事务锁、读取回退与严格写入策略不变。
- 六个 IPC 保留名称、参数和返回字段，各仅注册一次。
- 删除/清空仍按原顺序清理 Soul 来源、持久化、协调可见状态并广播更新。
- 临时上下文清理、气泡历史合并与去重行为不变。
- Agent、聊天、记忆提取和导入导出直接引用新模块，不新增依赖或数据迁移。

## 验证

- 17 个迁移定义与原始 token 比对一致（忽略可见性、空白与逗号格式）。
- 六个生产 IPC 注册逐一检查通过。
- cargo test --manifest-path src-tauri/Cargo.toml --lib：263 通过，1 跳过，包含既有会话分组、历史视图、保留上限、迁移幂等、备份、损坏与只读回退测试。
- cargo check --manifest-path src-tauri/Cargo.toml --lib：通过。
- npm run build：通过。
- git diff --check：通过。

未执行原生窗口交互、真实用户数据删除或外部模型请求测试。
