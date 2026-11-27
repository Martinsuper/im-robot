# 免手操作语音确认与延迟改进（2026-11-08）

## 行为

- 桌面语音使用独立确认通道：完整播报待执行内容后自动录音，直接接收“确认”或“取消”，无需再次喊唤醒词。
- 日程播报包含标题、起止日期时间、时区及其他参数；其他应用操作和文件/命令授权也可在内容足够短、可完整朗读时通过语音确认。文件/命令授权同时说明工作目录。
- 明确整句答复才批准；含糊答复重试一次，超时、录音/转写/播报失败均不批准。每次答复绑定唯一确认码，过期、已完成或其他操作的确认不能复用。
- 过长或无法完整朗读的内容会说明原因并拒绝执行，不从截断摘要获得授权。已有文件的目录选择仍需桌面；语音通道会停止该任务并说明限制。
- 唤醒及可语音确认的操作不再自动打开面板或确认窗口；桌面和 Passport 的原有确认策略保留。
- 等待确认时会忽略助手自身的播报音频，播报结束后重新建立录音缓冲。电脑端改变或解决确认时，旧语音提示与录音同步取消。

## 延迟

- 普通语音静音收尾从 1500 ms 缩短为 800 ms；简短确认答复使用 600 ms 收尾。
- 唤醒后、用户仍在讲话时预热本地识别器；短确认开头的人声不会被初始化为背景噪声。
- “现在几点”等明确时间问题本地回答；不拦截创建、记录等操作请求。
- macOS 系统语音直接边合成边播放，省去完整 WAV 生成等待；当前 MiMo 配置继续使用流式播放。
- 新增 Agent 阶段耗时、MiMo 首块音频等待及完整播报耗时日志。网络模型及 MiMo 服务仍会影响响应速度，不承诺固定响应秒数。

## 自动验证

- `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib voice`：27 项通过，2 项依赖外部语音资源的测试按原规则忽略。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib device_agent`：6 项通过，覆盖确认码失效、重放、拒绝、完整日程参数及原有设备确认限制。
- Tauri debug 完整构建通过，包含 TypeScript 与 Vite 构建。
- 最终打包重签名、麦克风 entitlement、内置 Node/SDK/adapter/protocol、DMG 挂载与 ZIP 解包后的签名检查均通过。
- `git diff --check` 通过。

## 安装与实测

- 新版已安装到 `/Applications/Piko.app`，旧版备份在 `/Users/duanluyao/Library/Application Support/Piko/installation-backups/20261108-184621-voice-confirmation/Piko.app`。
- 测试包：`output/voice-confirmation/Piko_1.3.1_aarch64.app.zip`。
- 运行日志：`/tmp/piko-voice-confirm.stderr.log`。
- 本地 ad-hoc 测试版签名改变后，macOS 再次请求麦克风授权；随后日志已确认授权通过，KWS 检测器已就绪。
- 后续已连接并自动切换至 AirPods Pro。真人语音被识别为“确认”，用户也明确说明实际说的是确认。已核对 `schedule-items.json` 中存在「语音测试」日程，起止为 2026-11-09 09:00–10:00（北京时间），语音确认创建链路实测通过。取消分支已有自动测试，尚未完成真人取消验收。
