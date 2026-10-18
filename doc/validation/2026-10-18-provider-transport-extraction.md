# 模型供应商与网络基础设施收敛验证

日期：2026-10-18

## 完成内容

- 17 个核心函数、ProviderKind、ModelInfo 和工具调用增量 DTO 进入实际编译的 providers.rs，替换原先未参与编译的旧副本。
- 模型列表命令进入 providers_commands.rs；命令名、参数和返回 JSON 保持兼容。
- 聊天流直接复用供应商文本与工具增量解析；角色生成复用请求 URL、客户端和认证；配置命令直接复用地址规范化与参数校验。
- 保留本地地址代理策略、超时、供应商别名、模型名称处理及错误传播行为。
- request_builder 包装原有认证构造，内部显式密钥入口用于验证请求协议，不修改用户凭据。
- 迁入 4 项既有协议测试，新增 3 项请求认证回归测试，覆盖 OpenAI 兼容认证、Anthropic 认证、Gemini 查询参数保留及编码，以及无密钥本地请求。

## 验证结果

- 除认证包装外的 17 个迁移函数（含模型列表命令）与迁移前词法一致，仅改变可见性和格式。
- cargo test --manifest-path src-tauri/Cargo.toml --lib：260 通过、1 跳过。
- cargo check --manifest-path src-tauri/Cargo.toml --lib：通过。
- npm run build：通过。
- git diff --check：通过。

本轮未改变 Node/Pi SDK 链路、业务工具确认或聊天编排。认证测试构造请求，不访问真实模型服务；未进行供应商在线验收或操作系统级桌面测试。
