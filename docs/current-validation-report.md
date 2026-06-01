# 当前功能自动化验证报告

> 验证日期：2026-06-01
> 范围：现有桌面骨架、Web 预览交互、Rust 核心逻辑、构建质量门禁

## 自动化结果

| 检查项 | 结果 |
| --- | --- |
| `npm run test` | 通过，6 个前端状态机测试 |
| `npm run build` | 通过 |
| `cargo fmt --check` | 通过 |
| `cargo clippy --all-targets --all-features -- -D warnings` | 通过 |
| `cargo test` | 通过，26 个 Rust 单测 |
| `npm run test:e2e` | 通过，4 个 Web 预览场景 |
| `npm run tauri dev` | 通过，桌面开发版可启动 |

## Browser 回归

已验证：

- `pet` 视图正常渲染
- 精灵可在“Rest”和“Awake”之间切换
- `bubble` 可提交浏览器预览问题并显示回复
- `bubble` 提交后可停止生成
- `bubble` 可复制当前结果到剪贴板
- `bubble` 提供当前回复的朗读入口
- `panel` 正常渲染模型设置和能力状态
- `panel` 可切换多提供商，Anthropic 预设会自动更新 Base URL 和模型名称
- `panel` 五个 Tab 可切换，当前 Tab 正确高亮
- `panel` 提醒表单提供一次性、每天、每周和工作日规则
- `panel` 正常渲染历史空状态，空列表时清除按钮禁用
- 互动活泼度可切换为“活泼”
- 紧凑版 `pet`、`bubble`、`panel` 视图正常渲染
- 浏览器控制台无错误

本轮新增 Playwright Web 预览 E2E，覆盖精灵、气泡、面板和截图蒙层四个视图。内置 Browser 插件受本机系统策略限制无法建立连接，已改用本机 Chrome 完成本地自动化回归。

## 桌面壳层覆盖

由 Rust 测试、编译和启动检查覆盖：

- 窗口配置可编译
- 托盘和全局快捷键初始化可编译
- 精灵位置范围判断
- Base URL 规范化
- OpenAI-Compatible、Anthropic 和 Gemini SSE delta 解析
- 多提供商 URL、模型列表和多模态截图请求体转换
- 默认互动活泼度
- 空闲检测阈值、暂停感知和忙碌状态抑制

仍需人工桌面冒烟：

- 托盘点击恢复精灵
- macOS `Command+Shift+Space`
- Windows 和 Linux `Ctrl+Shift+Space`
- 多显示器自由拖动和重启位置恢复
- Keychain API Key 保存
- 使用真实 OpenAI Compatible、Anthropic、Gemini、DeepSeek 和 DashScope 服务的 SSE、取消和超时行为
- 气泡窗口拖入 `.txt`、`.md`、`.json`、`.csv`、`.log` 后的预览、移除和三种处理动作
- 截图框选、系统屏幕录制权限提示、预览移除和真实多模态模型回复
- 系统空闲后自动休息、恢复输入后自动唤醒；Linux 额外验证 `xprintidle` 缺失时的静默降级

## 已修复问题

- 修复快速 SSE 回复可能早于前端监听器更新导致的首段丢失。
- 修复 Windows 和 Linux 错误使用 `SUPER` 快捷键修饰符。
- 修复 Clippy `needless_borrow` 警告。
- 增加停止生成、复制结果、最近历史和清除入口。
- 将聊天生命周期同步给精灵窗口。
- 本地模型服务地址绕过系统代理，避免 Clash 等代理返回 `502 Bad Gateway`。
- 统一 Rust 和 React 的聊天事件字段命名，并按序号去重 SSE delta。
- 移除边缘吸附，拖动停止后原位保存精灵位置。
- 收紧桌面窗口尺寸和界面间距，聊天正文区和历史区使用内部滚动。
- 新增受控文本附件：Rust 内存暂存正文，前端只显示脱敏预览，确认动作后才进入模型上下文。
- 新增提醒事项：本地持久化、启动恢复、到期单次触发和系统通知。
- 新增精灵名称、主题色、暂停主动感知和开机启动设置。
- 新增权限中心和基于 GitHub Releases 的联网检查更新入口。
- 新增主动截图提问：区域框选、内存预览、移除和确认后多模态发送。
- 新增文本文件选择器、会话级最近十轮上下文和历史实时刷新；应用重启后不会恢复旧上下文。
- 优化 Markdown：GFM 表格、代码块复制、安全外链和自适应图片。
- 新增面板 Tab 导航、周期提醒和离线系统 TTS 回复朗读；朗读会跳过 emoji，Web 预览保留 Web Speech API 回退。
- 面板关闭改为隐藏；如果精灵此前已隐藏，关闭面板会自动恢复精灵，避免失去可见入口。
- 新增专注模式：15 / 25 / 45 / 60 分钟计时、暂停、继续、结束、完成通知、今日累计，以及 5 / 10 / 15 分钟休息倒计时。
- 新增受控回复保存：系统保存对话框、扩展名白名单和覆盖前确认。
- 新增 Playwright Web 预览 E2E 和跨平台桌面冒烟清单。
- 新增 P2 空闲检测：仅查询系统空闲时长，按活泼度自动休息和唤醒，不读取具体输入内容。
- 新增 P2 多提供商适配：Anthropic、Gemini、DeepSeek 和 DashScope 预设，提供商认证、模型列表、文本和截图流式协议转换。
