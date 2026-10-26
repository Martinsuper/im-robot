# Desktop AI Pet Assistant

跨平台桌面 AI 宠物精灵助手。

## 当前进度

P0 基线与 P1 体验打磨已完成，P2 能力扩展已完成专注模式和受控文件写入。当前已实现：

- `pet`：透明置顶的桌面精灵窗口
- `bubble`：快速聊天与右侧工作区共用一个窗口；点击顶部「头像 / 名称」菜单选择今天、记录或设置
- 工作区：右侧按钮展开或收起，保留聊天草稿、正在运行的任务、已访问栏目的表单与滚动位置；窄窗口切为单页，通过「返回聊天」恢复对话
- 原主面板、托盘和精灵右键入口统一打开聊天窗口中的工作区；`?view=panel` 保留为工作区展开预览地址
- 系统托盘：打开助手、显示精灵、退出
- 全局快捷键：`CommandOrControl+Shift+Space`
- 精灵位置：可自由拖动放置，并在重启后恢复
- 互动活泼度：在面板中选择，并写入本地设置
- 模型服务：支持 OpenAI Compatible、本地 Ollama / LM Studio / vLLM、Anthropic Claude、Google Gemini、DeepSeek 和通义千问 DashScope
- AI 对话：通过 SSE 流式显示模型回复，并携带会话级最近十轮上下文
- 对话控制：支持停止生成、复制结果、最近历史和清除入口
- 文本附件：可拖入单个受控文本文件，预览后选择总结、翻译或解释
- 截图提问：主动框选屏幕区域，预览确认后再发送给模型
- 提醒事项：支持创建、删除、重启恢复、周期规则和到点系统通知
- 个性化：支持精灵命名、主题色、暂停主动感知和开机启动
- 更新检查：联网查询 GitHub Releases，并跳转到下载页
- 对话窗口：可调整大小，自动记住尺寸，支持背景拖拽移动
- Markdown 渲染：支持 GFM 表格、代码块复制、安全外链和自适应图片
- 语音朗读：使用本地系统 TTS 朗读回复，Web 预览使用 Web Speech API 回退
- 专注模式：支持专注和休息倒计时、暂停、继续、完成通知和今日累计
- 受控文件写入：将回复保存为白名单类型文件，覆盖已有文件前需要确认
- 空闲检测：根据系统距上次输入的时长自动休息和唤醒，不读取具体输入内容
- 业务插件骨架：支持通过对话生成提醒草稿，确认后由内置提醒插件执行
- 本地日程插件：支持面板管理、时间冲突检测，以及通过对话生成日程草稿
- OpenAI Compatible、Anthropic 和 Gemini Tool Use：模型可自主调用插件；只读工具自动回传，写入工具确认后回传模型生成收尾，不兼容模型自动降级为普通聊天
- 批量日程规划：候选项逐项勾选确认，支持 iCalendar 导出并交给系统日历导入
- 外部业务插件：支持受限声明式只读插件，动态 WASM 沙箱可在受控运行时中执行

当前规划中的主功能已经全部落地，后续主要是继续打磨同步兼容、插件生态和跨平台体验。详见[桌面助手产品基线与路线图](doc/prd/02-desktop-assistant-baseline-roadmap.md)。

## 本地运行

```bash
npm install
npm run tauri dev
```

## 发布说明

如果没有 Apple Developer 证书和公证信息，GitHub Actions 生成的 macOS 安装包只能作为测试版分发，用户在首次打开时可能仍需要手动放行。

## Passport 硬件接入

支持将 FoloToy AI Passport 作为 Piko 的局域网终端：宠物动画、按键互动、专注计时同步和按住说话的语音任务。可查询知识、管理提醒/日程/备忘和专注；文件与命令操作沿用桌面授权流程。桌面端在设置 → 系统与数据 → Piko Passport 中开启，设备需要构建并刷入专用固件。见[接入设计与使用说明](doc/design/07-passport-device-bridge.md)和[固件构建说明](firmware/passport/README.md)。

## 文档

- [人宠交互详细实现方案](doc/prd/00-pet-human-interaction-detailed-design.md)
- [宠物身份与养成产品方案](doc/prd/01-pet-identity-nurturing-product.md)
- [桌面助手产品基线与路线图](doc/prd/02-desktop-assistant-baseline-roadmap.md)
- [桌面代理交付计划](doc/prd/03-desktop-agent-delivery-plan.md)
- [宠物核心系统设计](doc/design/01-pet-core-systems.md)
- [角色驱动化视觉系统设计](doc/design/05-piko-character-driven-visual-system.md)
- [角色驱动化视觉技术方案](doc/design/06-piko-character-driven-visual-implementation.md)
- [应用壳层与桌面代理设计](doc/design/02-app-shell-agent-operations.md)
- [记忆、存储与数据设计](doc/design/03-memory-storage-and-data.md)
- [插件、素材与质量设计](doc/design/04-plugins-tooling-quality.md)

## 代码审查

- [代码审查总览与修复路线](doc/review/00-code-review-overview.md)
- [安全审查](doc/review/01-security-review.md)
- [前端审查](doc/review/02-frontend-review.md)
- [后端审查](doc/review/03-backend-review.md)
- [工程体系审查](doc/review/04-engineering-review.md)
- [测试覆盖审查](doc/review/05-testing-review.md)
- [性能审查](doc/review/06-performance-review.md)

## 素材来源

- 默认像素精灵使用 [OpenPets](https://github.com/alvinunreal/openpets) 的开源素材，遵循 MIT License。

## 开发验证与发布

首次验证前运行 `npm ci`、`npm --prefix agent ci` 和 `npx playwright install chromium`。浏览器测试默认使用 Playwright 配套 Chromium；本地调试可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 显式指定浏览器。

运行 `npm run verify` 检查版本、模块边界、翻译、Lint、单元测试和前端构建；运行 `npm run test:e2e` 完成浏览器交互回归。Rust 使用 `cargo fmt --check`、`cargo clippy --all-targets --all-features -- -D warnings` 和 `cargo test`（在 src-tauri 目录内）。CI 在 Linux、macOS、Windows 验证 Rust 与原生 Agent 运行时，macOS 额外验证通知和日历桥接。

API Key 使用系统凭据存储（macOS Keychain、Windows Credential Manager、Linux Secret Service）。Linux 需要可用且已解锁的 Secret Service；开发构建需要 `libdbus-1-dev`。旧 `api-credentials.json` 会在成功写入并验证系统凭据后删除；迁移失败保留原文件，并在设置中显示错误。单元测试使用模拟凭据，不读取或修改个人钥匙串。

发布先通过质量检查，再创建草稿、构建各平台安装包并上传 SHA-256 校验文件，全部成功后公开。应用按系统与 CPU 架构选择安装包，仅接受项目正式 Release 的 HTTPS 地址，校验摘要后才能打开文件。缺少匹配安装包或校验值时请从发布页手动下载。下载上限为 1 GiB，支持进度与取消。

macOS 最低版本为 14，截图使用 ScreenCaptureKit 的单帧截图接口，不再依赖已弃用的 Core Graphics 截图 API。

Windows/MSVC 构建通过链接器将 `src-tauri/windows.manifest` 同时嵌入应用和测试程序，以加载 Common Controls v6；否则库单元测试可能在运行前因 `TaskDialogIndirect` 入口点缺失（`0xc0000139`）而退出。


## 架构与数据维护

IPC 合约由 Rust 源码生成：修改命令或传输类型后运行 `npm run contracts:generate`，通过 `npm run contracts:check` 检查漂移。Pi SDK 接入集中在 `agent/sdk-adapter.mjs`；桌面端通过单实例插件保护本地数据访问。

设置页支持一致性完整备份、恢复预览及确认恢复后重启。备份包含归属清单内的业务 JSON、SQLite 与 Agent 会话，不含凭据、缓存、插件程序和工作区原文件；上限为 2 GiB / 2 万文件。交互式恢复要求应用版本一致，校验内容并保留回滚快照。存储健康信息提供锁等待与持有指标。

Rust 默认启用 `speech-recognition` 与 `wasm-plugins`；可使用 `cargo check --manifest-path src-tauri/Cargo.toml --no-default-features` 检查精简后端。完整边界、依赖及验证记录见[架构优化实施记录](doc/review/architecture-optimization-2026-10-18.md)。


## 自动化桌面验收

运行 `npm run verify:desktop` 可依次执行前端、端到端、Rust、完整/精简构建检查、打包 Node/Agent 与原生桥接测试，每次结果和日志保存在 `artifacts/acceptance/`。macOS 可运行 `npm run verify:desktop -- --bundle`，额外构建应用包并检查版本、权限文案、架构、随包源码及 Node/SDK 加载。单独检查现有包使用 `npm run inspect:bundle`。

验收脚本不启动正式桌面应用；交互式系统权限、真实桌面多窗口、退出重启和签名/公证仍需对应设备验收。三平台 CI 会运行打包 Agent 测试，前端 CI 失败时保留 Playwright 诊断文件。

依赖审计可在安装 `cargo-audit` 后通过 `npm run verify:desktop -- --audit` 纳入验收；安全公告命中会导致验收失败。最近结果见[自动化验收记录](doc/review/desktop-acceptance-2026-10-19.md)。


依赖安全修复后，默认 Rust 构建要求 Rust 1.96+；截图后端采用 xcap，Linux 还需 PipeWire/XCB 开发包及 libclang。语音 FFI 的 ZIP 构建依赖补丁和审计边界见[依赖安全修复记录](doc/review/dependency-security-remediation-2026-10-19.md)。
