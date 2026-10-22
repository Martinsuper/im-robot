# 多窗口与并行任务原生验收（2026-10-22）

## 环境与方法

在 macOS arm64 上构建并运行独立的 `Piko Parallel Acceptance.app`，应用标识为 `com.duanluyao.imrobot.parallelacceptance20261022`。配置、会话和凭据命名空间与正式应用隔离。模型端点为 `127.0.0.1:18765` 的合成 SSE 服务，测试消息与文件均为合成数据。

通过原生应用辅助功能及界面完成操作；通过后端任务日志和实际文件读回交叉核验。未授权屏幕录制、麦克风或日历权限，未使用真实模型账户。

## 已验证

1. 创建 NATIVE_ONE，收到流式内容后弹出原生窗口；恢复的窗口显示相同任务及部分回复。
2. 回到主窗口新建 NATIVE_TWO。界面显示 2/2，任务日志证明两项任务执行区间重叠。
3. 仅取消 NATIVE_TWO；NATIVE_ONE 在独立窗口保持运行。
4. 在 NATIVE_ONE 输入合成草稿，通过原生关闭按钮收回会话。主窗口恢复草稿与流式内容，任务仍保持运行，随后正常完成。
5. 选择 `artifacts/parallel-acceptance/input.txt` 并转移窗口；附件名称、大小、操作类型与草稿保留。
6. 正常退出后重新启动验收应用，未关闭的独立窗口及 760×760 几何配置恢复；文字草稿与历史回复可见。附件未被错误恢复为有效句柄，未产生新的用户任务。
7. 在新独立会话中请求合成文件写入，选择验收目录后出现真实工具审批卡片。
8. 审批尚未处理时返回主窗口；相同操作、路径和确认卡片恢复。批准后原任务继续完成。
9. `native-proof.txt` 的内容与预期完全一致。任务记录只有一次 write 工具调用，verification 为 verified。

10. 使用最新验收包，从 NATIVE_ONE 独立窗口的任务记录中点击已取消任务的“安全续跑”。应用切换到主窗口的原会话，接续请求完成；后端记录的 conversationId 与原任务一致，resumeOf 指向原取消任务。

基础验收前三项任务记录为 completed、cancelled、completed，附加续跑产生一条 completed 记录。后台记忆模型请求与用户任务分开计数；两个并行用户任务各自在其执行区间内只有一次模型请求。

## 证据

- `artifacts/parallel-acceptance/native-report.json`：机器可读结果与任务记录。
- `artifacts/parallel-acceptance/two-running.png`：2/2 原生界面。
- `artifacts/parallel-acceptance/returned-running-draft.png`：收回后回复与草稿。
- `artifacts/parallel-acceptance/detached-attachment.png`：独立窗口中的附件与草稿。
- `artifacts/parallel-acceptance/approval-returned.png`：待审批操作收回主窗口。
- `artifacts/parallel-acceptance/resume-original-conversation.png`：跨会话安全续跑回到原会话。
- `artifacts/parallel-acceptance/model-events.jsonl`：合成服务事件时间线。
- `artifacts/parallel-acceptance/native-proof.txt`：实际工具写入后的读回文件。
- `artifacts/parallel-acceptance/build.log`、`production-build.log`：隔离验收包与正式应用包构建日志。

## 边界

截图来源路由已实现，未授予屏幕录制权限，因此未实测操作系统授权后的屏幕采集。应用退出后不自动重放任务；附件与截图只在同一运行进程的窗口转移中保留。验收结束后已退出隔离应用并停止合成服务。

## 最终自动检查

310 项前端单元测试、73 项 Agent 测试、349 项 Rust 测试、138 项浏览器回归和 25 项构建脚本测试通过。Rust 的 4 项既有环境依赖测试保持跳过。Lint、Clippy、版本/架构/语言键/IPC 合约检查、正式应用构建和包内 Node/SDK/运行时检查通过。

正式应用包位于 `src-tauri/target/release/bundle/macos/Piko.app`。`native-report.json` 记录其可执行文件 SHA-256，以及原生任务与续跑核验结果。
