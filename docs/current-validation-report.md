# 当前功能自动化验证报告

> 验证日期：2026-05-31  
> 范围：现有桌面骨架、Web 预览交互、Rust 核心逻辑、构建质量门禁

## 自动化结果

| 检查项 | 结果 |
| --- | --- |
| `npm run test` | 通过，3 个前端状态机测试 |
| `npm run build` | 通过 |
| `cargo fmt --check` | 通过 |
| `cargo clippy --all-targets --all-features -- -D warnings` | 通过 |
| `cargo test` | 通过，5 个 Rust 单测 |
| `npm run tauri dev` | 通过，桌面开发版可启动 |

## Browser 回归

已验证：

- `pet` 视图正常渲染
- 精灵可在“Rest”和“Awake”之间切换
- `bubble` 可提交浏览器预览问题并显示回复
- `bubble` 提交后可停止生成
- `bubble` 可复制当前结果到剪贴板
- `panel` 正常渲染模型设置和能力状态
- `panel` 正常渲染历史空状态，空列表时清除按钮禁用
- 互动活泼度可切换为“活泼”
- 紧凑版 `pet`、`bubble`、`panel` 视图正常渲染
- 浏览器控制台无错误

## 桌面壳层覆盖

由 Rust 测试、编译和启动检查覆盖：

- 窗口配置可编译
- 托盘和全局快捷键初始化可编译
- 精灵位置范围判断
- Base URL 规范化
- OpenAI-Compatible SSE delta 解析
- 默认互动活泼度

仍需人工桌面冒烟：

- 托盘点击恢复精灵
- macOS `Command+Shift+Space`
- Windows 和 Linux `Ctrl+Shift+Space`
- 多显示器自由拖动和重启位置恢复
- Keychain API Key 保存
- 使用真实模型服务的 SSE、取消和超时行为

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
