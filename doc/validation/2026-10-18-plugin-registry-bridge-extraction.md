# 插件注册与工具桥接拆分验证

日期：2026-10-18

## 完成内容

- 34 个现有定义与实现（约 807 行主体代码）从 lib.rs 进入 plugins 子模块。
- 按注册表与协议 DTO、内置插件、外部插件运行时、模型协议桥接、查询命令划分职责。
- 6 项既有测试随实现迁入 plugins/tests.rs，覆盖内置注册、模型工具 schema、流式调用解码、协议结果封装和只读声明式插件校验。
- 三个查询命令 list_business_plugins、list_external_plugins、list_provider_tools 保持名称、参数和返回类型兼容，并在生产 invoke_handler 中各注册一次。
- 草稿、确认队列、业务写入及 Agent 审批和检查点流程保留原有实现。

## 验证结果

- 34 个迁移项的词法核对一致，仅调整可见性、导入及格式。
- 生产 IPC 注册核对：三个迁移命令均以 plugins::commands 路径存在且只注册一次。
- cargo test --manifest-path src-tauri/Cargo.toml --lib：260 通过、1 跳过。
- cargo check --manifest-path src-tauri/Cargo.toml --lib：通过。
- npm run build：通过。
- git diff --check：通过。

本轮未迁移插件数据、改动授权策略或运行操作系统级插件查询窗口测试。WASI 运行时行为由现有实现原样迁移，未新增真实外部插件执行验收。
