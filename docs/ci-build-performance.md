# Release 构建耗时与优化

分析运行：Release Build 39956723640，v1.2.24，2026-10-23。

## 实测耗时

- 原工作流先完成验证，再开始所有平台的 Release 构建。
- Windows 验证约 18 分 32 秒，是验证阶段的关键路径；其中 Clippy 完整功能约 339 秒、精简功能约 108 秒、Rust 测试构建与执行约 449 秒。
- Apple Silicon 整个打包任务约 12 分 13 秒，Build Tauri app 约 677 秒。
- Linux 安装系统依赖 759 秒；Azure Ubuntu 镜像下载约 27 MB WebKit 动态库时，日志记录到约 284 秒等待。Release 编译 9 分 47 秒，随后 AppImage 等打包也有耗时。
- Windows Release 打包任务约 24 分 29 秒。
- 本次观察时 Intel macOS 仍在运行，尚不能获取完整任务日志，因此不将它推断为卡死或失败。历史成功版本 v1.2.21（运行 39890648525）的 Intel Build Tauri app 用时 40 分 45 秒，整个任务 42 分 51 秒，明显慢于其他平台。

## 配置改进

- 草稿准备、构建与验证并行；publish 依赖 verify、prepare 和全部 build 成功。验证失败时不会公开发布。
- Rust 验证、Release 构建、合约生成器与 cargo-audit 使用 Rust Cache；缓存按工作区、工具链和任务区分。
- Agent npm lockfile 纳入下载缓存；仍执行 npm ci，以保持锁文件和平台依赖一致。
- main 推送自动运行 Verify，及时验证主分支并积累主分支可复用缓存。
- 原生 macOS runner 只使用本机默认 Rust target，不额外安装另一架构的标准库。
- Linux 统一安装脚本，将已知较慢的 Azure Ubuntu 镜像替换为官方 archive.ubuntu.com HTTPS 地址；保留 apt 签名验证，减少 recommends 包并添加重试。

## 预期与限制

并行可移除本次约 18 分钟的验证前置等待，但会增加同时占用的 runner 数量；实际提速受 GitHub 并发额度、镜像网络和缓存命中影响，未做新旧配置的同条件基准对比。

首次填充缓存仍可能耗时。GitHub 缓存受分支和标签作用域限制，不能保证不同发布标签之间直接命中 release profile 缓存；同一标签重跑及主分支验证收益更确定。本轮已启动的任务仍使用标签中的旧配置，不能被后续 main 修改即时加速。

本地验证：工作流 YAML 解析、actionlint、发布门禁与发布脚本测试、Linux 安装脚本 bash 语法检查通过。Linux 镜像切换仍需下一轮 hosted runner 验证实际下载速度。
