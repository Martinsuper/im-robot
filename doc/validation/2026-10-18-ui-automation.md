# Piko UI 交互自动化验收

日期：2026-10-18。执行入口：`npm run test:ui`（先构建，再启动独立预览服务并运行 Playwright）。

## 最终结果

Playwright：**106 通过，0 失败，0 跳过，0 flaky**；共 16 个测试文件，耗时 76.2 秒。未使用重试掩盖失败。

- 生产构建通过。
- 前端组件/状态测试：33 个文件、234 项通过。
- `git diff --check` 通过。
- 支持尺寸 360×560 与 400×700 的三个面板页面均完成横向溢出断言与截图取证；聊天窗口另有 360×300 与 480×420 交互测试。

## 覆盖矩阵

| 测试文件 | 用例数 |
| --- | ---: |
| `agent-tasks.spec.ts` | 32 |
| `capture-functional.spec.ts` | 5 |
| `html-favorites.spec.ts` | 6 |
| `html-preview.spec.ts` | 4 |
| `layout-evidence.spec.ts` | 2 |
| `memory-functional.spec.ts` | 4 |
| `memory.spec.ts` | 1 |
| `model-settings.spec.ts` | 5 |
| `onboarding-functional.spec.ts` | 3 |
| `panel-functional.spec.ts` | 15 |
| `panel-tabs.spec.ts` | 5 |
| `pet-appearance.spec.ts` | 6 |
| `previews.spec.ts` | 4 |
| `records-functional.spec.ts` | 4 |
| `records-smoke.spec.ts` | 4 |
| `settings-functional.spec.ts` | 6 |

覆盖首次引导、窗口入口与形象、今天/记录/设置导航、提醒重复规则与增删完成、日历时长与删除、专注/休息全部预设、同步/导出及取消、记录新增/编辑/取消/删除/搜索/历史清理、记忆置顶/取消/删除/候选审核/自动提取、设置持久化、Soul 设置与人格版本、模型密钥保存及失败、统一聊天/目录/任务/审批/恢复/取消、回复复制/朗读/保存/覆盖确认、文本附件、截图按钮/Enter/右键/权限失败，以及 HTML 预览与收藏。

本次另导出 6 张面板截图到 `test-results/ui-evidence/`，并抽查了今天（360×560）、记录（400×700）、设置（400×700）截图，未见横向溢出或控件重叠。截图取证不等同于像素差异基线回归。

## 发现及处理

### 产品修复

1. 设置页初始化的插件列表、截图权限、自启状态与通知权限查询未完整处理失败，可能出现未处理的 Promise 拒绝。现已分别反馈失败状态/Toast，订阅清理也处理失败；失败注入测试确认页面无未捕获异常。
2. 记忆卡片按钮事件冒泡到卡片详情入口，导致置顶、反馈或删除时误开详情。按钮区域现阻止冒泡；完整置顶/取消置顶/删除回归验证列表刷新且不打开详情。

### 测试修复

- 设置分组断言更新为当前 7 组，包含“灵魂系统”，高级组仍默认折叠。
- Escape 按当前设计验证收起窗口但任务继续；另加显式“停止生成”取消测试。
- 模型设置模拟器补齐新增 Soul 接口的合法响应，避免旧的通用数组返回值使角色 UI 崩溃。
- 提醒、记录与设置采用有状态、可跨页面刷新恢复的隔离 IPC 模拟器，验证真实组件交互及参数；不触碰用户存储、真实密钥、系统剪贴板或文件。

## 报告与复跑

- HTML 报告：`playwright-report/index.html`。运行 `npm run test:ui:report` 可查看。
- JSON 结果：`test-results/results.json`。
- 截图：HTML 报告附件（含 6 张面板尺寸取证图），失败时自动留图。
- `playwright.config.ts` 固定中文、2 个 worker、单测试 30 秒、全局 10 分钟，自动启动/关闭独立测试服务；默认不重试。
- 本机早期 Trace 采集曾出现收尾等待，默认关闭 Trace。必要时可用 `PIKO_UI_TRACE=1 npm run test:ui` 显式采集。

## 验证边界

本次运行的是 Chromium 中的真实 React 页面，以及浏览器预览或模拟 Tauri IPC。验证界面行为、参数、状态更新和异常反馈；不代表 Rust 命令或原生系统副作用已端到端实测。

尚未实机覆盖：操作系统窗口/托盘/快捷键、真实屏幕内容读取、系统通知、自启注册、麦克风录音与真实语音识别、真实文件读写、系统日历同步、真实模型请求、语音模型/应用更新下载与安装。同步、朗读、文件对话框等在本次测试中验证了 UI 到 IPC 的交互约定，相关系统效果由隔离模拟器替代。
