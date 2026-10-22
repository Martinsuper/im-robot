# macOS 应用包验收（2026-10-22）

本次验收基于当前工作区，包含代理编辑检查点、导入凭据保护及对话恢复修复。

## 结果

| 检查 | 结果 |
| --- | --- |
| 原生 Node/SDK 运行时 | 通过，darwin arm64，Node v22.23.3 |
| 日历桥接 | 权限预检、Unicode、原生异常处理通过；未读写用户日历 |
| 通知桥接 | 4 类授权状态及 JSON 布尔类型检查通过 |
| 构建脚本 | 25 项通过 |
| 精简配置 Clippy | `--no-default-features --all-targets -- -D warnings` 通过 |
| macOS release 应用包 | 构建成功，版本 1.2.16 |
| 应用包检查 | 版本、权限说明、ARM64 架构、代理源码一致性、Node/SDK 加载通过 |
| 最终应用包内的代理测试 | 直接使用 `.app` 内的 Node 和 sidecar，71 项全部通过 |

## 产物与范围

- 应用包：`src-tauri/target/release/bundle/macos/Piko.app`，约 290 MiB。
- 详细日志：`artifacts/acceptance/desktop-bundle-2026-10-22/`。
- 本次未启动应用进行真实桌面交互，未验证用户授予系统权限后的完整操作，也未验证开发者签名或公证状态。
- 构建仍有第三方 xcap 的 macOS 弃用 API 警告，不影响本轮构建与检查通过。
