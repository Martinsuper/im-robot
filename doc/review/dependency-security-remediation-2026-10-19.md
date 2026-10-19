# 依赖安全修复（2026-10-19）

## 修复范围

在保留现有功能的前提下，升级前端和 Rust 依赖，消除上一轮 npm 的 13 项告警与 Rust 锁文件的 28 条漏洞公告命中。审计使用实时公告库；没有添加公告忽略规则或修改审计严重性阈值。

- npm 兼容范围更新修复测试工具、CSS/源码映射和工具链依赖。Vitest 升级到 4.1.12。
- KaTeX 升级到 0.19.0，并通过 `$katex` override 统一 rehype-katex 与 micromark-extension-math 内部版本。保持原有 Markdown 插件版本，不采用 audit 建议的插件大幅降级。补充真实公式渲染和不可信 TeX 命令回归测试。
- Wasmtime/wasmtime-wasi 升级到 49.0.3。原有 fuel、epoch、内存、栈、输入输出和路径限制保留。默认构建需要 Rust 1.96 及以上，已在 Cargo.toml 中明确最低版本。
- Rust 依赖整体在各声明兼容范围内刷新，包括 rustls 0.23.46、h2 0.4.20、crossbeam-epoch 0.9.21，及相关 Tauri/系统插件。
- screenshots 0.8.10 迁移到同类维护库 xcap 0.9.8，移除其旧 Wayland/XML 解析依赖；保留截图权限、选区和 PNG 输出流程，适配新的监视器与区域捕获接口。
- sherpa-onnx-sys 1.13.8 上游仍固定 zip 2。以带 Apache-2.0 许可证和来源说明的本地补丁，仅将 ZIP 构建依赖升级到 9 系列（锁定结果 9.0.5）；FFI 和原生库版本不变。补丁目录记录原始 crate SHA-256，后续上游修复后删除补丁。ZIP 路径用于 iOS XCFramework，桌面原生库仍使用 tar.bz2。

## 自动防回退

CI 的 npm/Agent 安装后执行安全审计，新增 Rust 安全审计任务检查应用和合约工具两份 Cargo.lock。未使用 `--ignore` 或仅检查高危的阈值。原有三平台测试矩阵保留。

xcap 的 Linux 后端需要 PipeWire/XCB 开发包及 libclang，CI 和发布工作流已补齐 `libpipewire-0.3-dev libxcb-randr0-dev libclang-dev`。

## 审计结果

- npm 前端：0 个漏洞（原 13）。
- npm Agent：0 个漏洞。
- Rust 应用锁文件：0 个漏洞命中（原 28）。
- Rust 合约生成工具锁文件：0 个漏洞命中。

RustSec 仍报告上游维护性和健全性提示：proc-macro-error、zbus_names、zvariant/derive，以及 Linux GTK 依赖中的 GLib 0.18.5 的 VariantStrIter DoubleEndedIterator 问题。这些未被忽略，原始审计输出完整保留。GLib 的接口受 Tauri/GTK 依赖链约束，不能以跨不兼容版本覆盖来宣称修复；本项目没有直接调用 VariantStrIter。上述提示不计入 cargo-audit 的 vulnerability 命中数，也不应理解为所有安全风险归零。

## 验证

前端 262 项测试（含补充的 2 项数学渲染测试）、Agent 源码与随包运行时各 65 项、完整端到端 115 项均通过。版本/架构/国际化/合约检查、Lint 和生产前端构建通过。

Rust 288 项测试通过、1 项忽略，另 1 项集成测试通过；默认及精简严格 Clippy 均通过。更新后的 macOS 应用包构建与包内版本、架构、权限文案、Agent 源码一致性及 Node/SDK 加载检查均通过。

另修复了日历测试按时间戳命名临时文件的并发碰撞风险，改用独立临时目录；Tauri Rust 与 npm 插件已同步到相同主/次版本，生产打包版本检查通过。

验证在 macOS ARM64 上执行，使用临时数据与模拟服务；未安装或启动正式应用，未修改真实用户资料。Windows/Linux 原生兼容性需对应 CI/设备确认。iOS ZIP 提取路径尚未做设备验收。

本轮原始审计 JSON、构建与测试日志保存在 `artifacts/security/2026-10-19/`，汇总为 `report.json`。应用包位于 `src-tauri/target/release/bundle/macos/Piko.app`；未安装、启动或发布，也未验证签名/公证。
