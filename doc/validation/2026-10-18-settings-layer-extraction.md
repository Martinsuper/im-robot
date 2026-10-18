# 配置层收敛验证

日期：2026-10-18

## 完成内容

- 当前运行的配置路径、读取和持久化进入 settings.rs，替换该文件中原先未参与编译的重复类型及旧存储实现。
- PreferencesInput、OnboardingStatus 和 11 个 Tauri 命令进入 settings_commands.rs；命令名称、参数、返回字段和事件行为保持兼容。
- 类型与默认值统一来自 app_settings.rs，凭据仍由 credentials.rs 独立管理。
- 工作节奏直接调用配置层读写入口；导入导出复用配置路径和写入入口。
- 导入更新使用 read_persisted_settings，继续传播损坏持久化数据的解析错误，不替换成默认配置。普通界面的默认值回退和导出缺失配置的空值语义保持不变。

## 验证

- 14 个迁移函数与迁移前的词法比较一致，仅改变可见性和格式。
- cargo test --manifest-path src-tauri/Cargo.toml --lib：257 通过、1 跳过。
- cargo check --manifest-path src-tauri/Cargo.toml --lib：通过。
- npm run build：通过。
- git diff --check：通过。

本轮未迁移数据、修改凭据格式或执行操作系统级设置窗口测试。模型供应商校验与网络适配仍保留现有实现，通过显式依赖调用。
