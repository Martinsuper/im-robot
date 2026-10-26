# Passport 0.2.0 语音验证

日期：2026-10-24。

## 通过的自动验证

- 桌面默认功能 `cargo build --manifest-path src-tauri/Cargo.toml --locked` 通过；仍有原有 xcap macOS API 弃用警告。
- `cargo test --no-default-features device_voice`：4 项通过，覆盖 PCM/WAV 格式、12 秒录音限制、22.05kHz 到 16kHz 重采样、回复长度、真实 WebSocket 分块发送与播放窗口，以及取消/析构清理。
- 显式运行 macOS 本地合成集成测试 `device_voice::tests::renders_local_chinese_without_playing_on_computer -- --ignored`：1 项通过。使用安装的 Tingting 音色生成有效 16kHz PCM，不从电脑扬声器播放。默认测试将此项标为依赖系统环境的 ignored。
- 原有设备认证/重传测试：5 项通过。
- `python3 firmware/passport/tests/run.py`：通过。使用真实 `passport_audio.c` 和 pthread/RTOS/I2S 替身验证录音结束、队列上限、音频顺序、播放消费确认、取消后立即重启、录音溢出恢复及不完整播放数据拒绝。
- 前端构建与 lint 通过；54 个文件、335 项前端测试通过。
- Passport 设置与原有设置流程：7 项 Playwright 测试通过。
- IPC 契约检查通过（216 条命令、151 个 wire 类型）；语音通过已认证 WebSocket 扩展，不新增公开 Tauri 命令。
- ESP-IDF 5.5.3 固件构建和镜像分段验证通过。应用约 2.15 MB，应用分区剩余约 37%；LVGL 内存池 24 KB，主任务栈 8 KB，I2S IRAM 安全中断已启用。
- Noto Sans SC 14px/2bpp 字体覆盖 7540 个 GB2312/ASCII 字符，附 OFL 授权；字体编译通过。屏幕实际字形仍待真机确认。

## 产物

`firmware/passport/build/piko-passport-0.2.0.zip`：独立 bootloader、分区表和应用镜像，含各段地址及 SHA-256。未整片合并，也未刷写设备。

## 尚未验收

没有连接 Passport USB，未进行物理录音、扬声器播放、音量、无线网络抖动、连续多轮语音、按键手感、电池消耗及运行时最低堆内存测试。未对 Windows/Linux 系统 TTS 做实机集成测试。未使用用户模型执行真实端到端 ASR→模型回复→设备播放；需在电脑下载 SenseVoice 并配置模型后上板验收。

本版提供语音对话与对话记录，不接入桌面工具执行、唤醒词或打断式全双工对话。长按录音松开发送；录音上限12秒，回复音频上限40秒。原有局域网明文传输边界保持不变。
