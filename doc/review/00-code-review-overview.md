# Piko 代码审查总览

> **修复状态（2026-09-30）**：阶段一、二全部完成并经 CI（linux + windows 双平台）验证全绿；
> 阶段三重构基本完成：F2 PanelWindow 1423→954 行（4 个 section 组件 + 筛选辅助模块）；B1 已拆出 8 个领域模块（lib.rs 6719→4771 行）；B4 thiserror 已在 providers/updates 落地样板；
> 另完成 F7 死代码清理（-1306 行）与 S5 Windows 键盘钩子改造（可随暂停感知卸载，附带新增 rust-windows CI job）。
> 剩余：F2 逐 tab 抽取、B1 其余 9 个模块、B4 thiserror 迁移。详见各分册「修复记录」。

## 1. 审查范围与方法

- 审查日期：2026-09-29，对应版本 v1.2.7（commit `767518b`，含工作区未提交的 `test_connection` 改动）。
- 覆盖范围：`src/`（React 19 + TypeScript 前端）、`src-tauri/`（Tauri 2 + Rust 后端）、`.github/workflows/`、构建与测试配置。
- 验证手段：
  - `npx tsc --noEmit` 通过；`npm test` 102/102 通过。
  - `cargo clippy` 本地因 shell 缺少 MSVC 环境无法编译（环境问题，CI 上 `clippy -D warnings` 持续通过）。
  - ESLint 当前无法运行（见 [04-工程体系](04-engineering-review.md)）。
  - 前后端各做了一轮逐文件深度审查，所有问题均带 `file:line` 证据。

## 2. 总体结论

工程质量中上：TypeScript 严格模式、Rust 主代码几乎零 `unwrap`、前后端共 100+ 个单测全部通过、API key 使用 keyring 存储、Tauri capabilities 权限收敛。这些基础是健康的。

主要风险集中在三类：

1. **安全防线缺位**：CSP 为 null、asset 协议开放整个主目录、两个任意路径写入、WASM 沙箱无资源限制。应用会渲染 AI 生成的 HTML，注入攻击链路是真实成立的。
2. **两个失控的巨型文件**：`PanelWindow.tsx`（1448 行）与 `lib.rs`（6719 行），是维护与测试的最大障碍。
3. **失效的 lint 体系**：ESLint 配置损坏且未接入 CI，前端代码质量完全依赖人工自觉。

## 3. 问题总表

严重度：高（安全或必然缺陷）/ 中（可稳定复现的质量问题）/ 低（打磨项）。

| # | 领域 | 严重度 | 状态 | 问题 | 详情 |
| --- | --- | --- | --- | --- | --- |
| S1 | 安全 | 高 | ✅ | CSP 为 null + asset 协议开放 `$HOME/**`，配合 HTML 预览构成 XSS→任意读写链路 | [01-安全](01-security-review.md) |
| S2 | 安全 | 高 | ✅ | `save_generated_text` 无目录限制，可写任意路径 | [01-安全](01-security-review.md) |
| S3 | 安全 | 高 | ✅ | `download_update_asset` 路径未消毒且下载内容无校验 | [01-安全](01-security-review.md) |
| S4 | 安全 | 中 | ✅ | WASM 插件无 fuel/epoch/内存限制，死循环插件永久挂死 tokio worker | [01-安全](01-security-review.md) |
| S5 | 安全 | 中 | ✅ | 全局键盘钩子启动即安装、无法卸载，隐私与杀软误报风险 | [01-安全](01-security-review.md) |
| F1 | 前端 | 高 | ✅ | `useTauriEventSubscription` 每次渲染重订阅，且存在监听器永久泄漏竞态 | [02-前端](02-frontend-review.md) |
| F2 | 前端 | 高 | ◐ | `PanelWindow.tsx` 1448 行、45+ useState 的上帝组件（settings 已合并为 useAppSettings） | [02-前端](02-frontend-review.md) |
| F3 | 前端 | 高 | ✅ | 全库 100 处 `runCommand` 零 `.catch`，大量 unhandled rejection 与静默吞错 | [02-前端](02-frontend-review.md) |
| F4 | 前端 | 中 | ✅ | listen 清理用 `mountedRef` 条件跳过 dispose；多个 timer/防抖未清理 | [02-前端](02-frontend-review.md) |
| F5 | 前端 | 中 | ✅ | PetDomainContext 快照挂载后永不更新；同窗口事件双通道重复 setState | [02-前端](02-frontend-review.md) |
| F6 | 前端 | 中 | ⬜ | i18n 仅 Onboarding 接入，其余 UI 硬编码中文，三份 locale 严重脱节 | [02-前端](02-frontend-review.md) |
| F7 | 前端 | 中 | ✅ | 约 1300 行死代码（pet/optimization、pet/outfit、useTauriEventSubscriptions） | [02-前端](02-frontend-review.md) |
| B1 | 后端 | 高 | ◐ | `lib.rs` 6719 行混杂 13 个领域、71 个 command（8 个领域模块已拆出至 4771 行，余下为 chat/plugins/窗口管理） | [03-后端](03-backend-review.md) |
| B2 | 后端 | 中 | ✅ | async `stream_chat` 中同步调用 rusqlite/文件 I/O，零 `spawn_blocking` | [03-后端](03-backend-review.md) |
| B3 | 后端 | 中 | ✅ | 9+ 个轮询线程每 1-2 秒重读 settings.json（每 2 秒至少 3 次） | [03-后端](03-backend-review.md) |
| B4 | 后端 | 中 | ◐ | 错误全部为 String（141 处）——thiserror 已在 providers/updates 落地样板，其余模块随拆分迁移 | [03-后端](03-backend-review.md) |
| E1 | 工程 | 高 | ✅ | ESLint 配置损坏无法运行，且 CI 无 lint 步骤 | [04-工程体系](04-engineering-review.md) |
| E2 | 工程 | 中 | ✅ | `ci.yml` 只在 pull_request 触发，push main 不做检查 | [04-工程体系](04-engineering-review.md) |
| E3 | 工程 | 低 | ✅ | `.tauri/` 未加入 `.gitignore`；e2e 浏览器探测只覆盖 macOS | [04-工程体系](04-engineering-review.md) |
| P1 | 性能 | 中 | ⬜ | 每个 PetSprite 独立 pixi Application，同屏多实例逼近 WebGL 上下文上限 | [06-性能](06-performance-review.md) |
| P2 | 性能 | 中 | ◐ | 后端轮询线程群持续读盘（settings 已缓存 ✅）；更新包整体读入内存（已改流式 ✅） | [06-性能](06-performance-review.md) |
| T1 | 测试 | 中 | ◐ | 窗口组件零覆盖（已补 useTauriEventSubscription 4 用例 + preview URL 2 用例） | [05-测试](05-testing-review.md) |

图例：✅ 已修复　◐ 部分修复　⬜ 待处理

## 4. 做得好的部分（保持现状）

- **凭据管理**：API key 走 keyring，settings.json 只存 `has_api_key` 布尔；导入导出已脱敏（`sync/import_export.rs:12-58`）。
- **前端安全意识**：无 `dangerouslySetInnerHTML`；HTML 预览 iframe sandbox 未开 same-origin（`HtmlPreviewFrame.tsx:70`）；外链仅 http(s) 放行。
- **Tauri capabilities**：只有 core + autostart/notification/dialog/opener 默认权限，无 fs/shell 越权（`src-tauri/capabilities/default.json`）。
- **Rust 代码卫生**：主代码 0 个 `unwrap()`、0 个 `panic!`，锁均短持有且不跨 await。
- **测试基础**：tsconfig 严格模式全开；Rust 55+9 个纯函数单测质量不低；vitest 102 用例全过。
- **Live2D 清理**：模型销毁、ticker 移除、interval 清理完整（`Live2DCharacterPet.tsx:250-269`）。

## 5. 修复路线建议

按 ROI 排序，分四个阶段：

**阶段一：止血（1-2 天量级）**
1. 安全加固三件套：设置非 null CSP、asset scope 从 `$HOME/**` 收窄、给 `save_generated_text` / `download_update_asset` 加基准目录与 canonicalize 校验（S1/S2/S3）。
2. 修 ESLint：补装 `typescript-eslint`、CI 增加 lint 步骤、`ci.yml` 加 push 触发（E1/E2）。
3. WASM 沙箱加 fuel + epoch interruption + Store 内存 limiter（S4）。
4. `.tauri/` 加入 `.gitignore`（E3）。

**阶段二：缺陷修复（3-5 天量级）**
1. 重写 `useTauriEventSubscription`（handler 存 ref、deps 只留 eventName、无条件 dispose），同步修掉 `mountedRef` 跳过 dispose 的问题（F1/F4）。
2. 为 `runCommand` 提供统一错误策略（safe 包装或全局错误 toast），消灭 unhandled rejection（F3）。
3. 修 `scheduleFidget` timer 管理、PetDomainContext 快照冻结、MemoryCenter 搜索竞态（F4/F5）。
4. 后端：rusqlite/文件 I/O 包 `spawn_blocking`，settings 缓存进内存（B2/B3）。

**阶段三：结构重构（1-2 周量级）**
1. 机械拆分 `lib.rs`：settings / providers / chat / reminders / calendar / plugins / rhythm / capture / tts / updates 十个模块，大部分是自由函数，改动成本低（B1）。
2. 拆解 PanelWindow：按 tab 拆组件，settings 合并为单一对象 state 并抽 `useAppSettings()` hook（F2）。
3. 错误体系：Rust 侧引入 thiserror，逐步替换 `Result<_, String>`（B4）。

**阶段四：打磨（持续）**
1. 删除死代码、决断 i18n 去留（F6/F7）。
2. 按测试盲区清单补测（T1）。
3. Live2D 实例收敛、轮询 I/O 收敛（P1/P2）。

## 6. 文档索引

| 文档 | 内容 |
| --- | --- |
| [01-security-review.md](01-security-review.md) | 安全审查：威胁链路、任意写、沙箱限制、隐私 |
| [02-frontend-review.md](02-frontend-review.md) | 前端审查：组件结构、React 缺陷、错误处理、i18n、死代码 |
| [03-backend-review.md](03-backend-review.md) | 后端审查：lib.rs 拆分、并发异步、错误处理、依赖 |
| [04-engineering-review.md](04-engineering-review.md) | 工程体系：lint、CI、发布流程、仓库卫生 |
| [05-testing-review.md](05-testing-review.md) | 测试覆盖：现状盘点、盲区清单、补测建议 |
| [06-performance-review.md](06-performance-review.md) | 性能：前端渲染与 WebGL、后端轮询与 I/O |
