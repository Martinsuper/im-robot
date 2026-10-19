# 自动化验收记录（2026-10-19）

本文件记录修复前的验收结果；随后依赖漏洞已处理，见[依赖安全修复记录](dependency-security-remediation-2026-10-19.md)。

环境：macOS ARM64，当前本地工作区。使用临时数据与模拟模型服务；没有安装、启动正式桌面应用、调用真实云模型或修改真实用户数据。

## 结果

| 检查 | 结果 |
| --- | --- |
| 前端单元测试 | 41 文件、260 项通过 |
| Agent 源码测试 | 65 项通过 |
| 完整端到端回归 | 115 项通过 |
| Rust 单元/集成测试 | 288 项通过、1 项忽略；另 1 项集成测试通过 |
| 默认/精简 Rust 严格 Clippy | 均通过 |
| 合约生成器测试 | 1 项通过 |
| 版本、架构、国际化、合约漂移、Lint、生产构建 | 均通过 |
| 构建脚本测试 | 25 项通过 |
| 随包 Node 执行打包 Agent 测试 | 65 项通过 |
| 原生运行时 smoke | 通过 |
| macOS 日历与通知桥接 | 通过 |
| macOS 应用包构建与静态检查 | 通过；包内 Node 22.23.3、SDK、适配器及协议可加载 |
| npm 依赖审计 | 前端 13 项：6 high、3 moderate、4 low；Agent 0 项 |
| Rust 依赖审计 | 命中 28 条安全公告；另有未维护、不健全性与撤回警告 |

## 新增可复用入口

- `npm run verify:desktop`：顺序运行上述核心检查，输出每阶段日志及 JSON 汇总，任一阶段失败时以非零状态结束。
- `npm run verify:desktop -- --bundle`：macOS 额外构建 .app 并检查包内元数据、原生架构、权限声明、全部 Agent 源文件是否匹配，以及随包 Node/SDK/适配器/协议能否加载。
- 已修正一处测试固定使用 Bash 的平台假设，Windows 改用 PowerShell；macOS 打包运行时复测 65 项通过。
- `npm run test:agent:packaged`：使用目标平台随包 Node 与打包 sidecar 执行 Agent 测试；已加入 macOS/Windows/Linux CI。
- `npm run inspect:bundle`：检查已有 macOS .app，不启动桌面程序。

## 依赖审计后续

前端告警涉及 vitest/@vitest/mocker、baseline-browser-mapping、brace-expansion、browserslist、js-yaml、nanoid、postcss、source-map-js，以及 KaTeX 和数学渲染依赖链。审计结果包含开发工具和运行时依赖，不能将全部告警直接等同于桌面应用可利用漏洞。

建议单独进行依赖升级：先升级兼容范围内的间接依赖和测试工具，再验证 KaTeX 升级及数学渲染链兼容性。未使用 `npm audit fix --force` 自动降级数学插件，也未在验证期间修改依赖锁文件。

## 尚未覆盖

Windows/Linux 的原生运行与构建需远端 CI 或对应设备执行。本地未推送当前工作区，远端已有提交的绿色结果不能代表本次改动。

Playwright 回归使用浏览器模拟原生 IPC；Rust 测试和打包 Node 测试分别验证真实后端及 Agent，不能替代真实 WebView 的多窗口同步、系统权限弹窗、桌面退出重启和安装后恢复验收。应用包检查不验证开发者签名、公证或 Gatekeeper。


## Rust 安全公告与发布判断

本轮功能验证通过，但依赖安全门禁未通过，暂不作为可发布版本。28 条为锁文件中的公告命中次数，并非 28 个独立依赖或 28 条已证实可利用路径；部分依赖仅用于其他平台或可选功能，仍需逐项分析。

优先处理 Wasmtime/wasmtime-wasi 45.0.0：公告覆盖宿主崩溃、组件模型与燃料限制绕过等问题；多条公告要求升级至 48/49 系列的修复版本，因此需要验证 API 兼容性，不能只改锁文件。其次处理 rustls 0.23.40（公告修复版本至少 0.23.46）、h2 0.4.14（至少 0.4.16）、crossbeam-epoch 0.9.18（至少 0.9.20）。quick-xml 多个旧版本的公告要求至少 0.41.0，应沿上游依赖升级；不要跨不兼容版本强行覆盖。

原始公告、修复版本、依赖审计 JSON 和所有阶段日志保存在 `artifacts/acceptance/2026-10-19-local/`，汇总为同目录 `report.json`。该目录被 Git 忽略，仅作本地验证产物。

复验依赖时可在安装 `cargo-audit` 后运行 `npm run verify:desktop -- --audit`；任一依赖审计非零退出会使整体验收失败。签名、公证和远端三平台 CI 状态仍未验证。
