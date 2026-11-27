# 常驻语音助手唤醒排查（2026-11-08）

## 结论与证据

问题阻断在麦克风输入与系统授权层。修正签名后已安装到 `/Applications/Piko.app` 并启动，系统授权与真人唤醒均已验证通过。

- 本机设置：`voiceAssistantEnabled=true`、`sensingPaused=false`，唤醒词为「你好皮可」。
- KWS 模型已安装，encoder/decoder/joiner 文件齐全，配置的所有拼音 token 均存在于模型词表中。
- `/tmp/piko-debug2.log`、`/tmp/piko-debug3.log` 显示选中 BlackHole 2ch，检测器 `spotter=true`，但输入 `rms=0.0000`。虚拟回环输入没有收到人声，检测器自然无法命中。
- 后续 `/tmp/piko-debug6.log` 已选中 AirPods Pro，输入仍为零；`/tmp/piko-debug8.log` 显示麦克风授权状态为 `0`（未决定），停在请求授权之后。
- 修复前运行的 debug bundle 经 `codesign -dv --verbose=4` 检查，带有 Hardened Runtime；`codesign --display --entitlements - --xml` 输出为空。缺少 Hardened Runtime 音频采集所需的 `com.apple.security.device.audio-input`。
- 修复前只读查询用户 TCC 数据库，没有 Piko 的麦克风授权条目，与未完成授权的日志一致。

## 修复

- 添加 `src-tauri/Entitlements.plist`，声明麦克风输入 entitlement，并在 Tauri macOS 打包配置中引用。
- 修正 `scripts/package-macos.mjs`：最终重签名显式保留配置的 entitlement 和 Hardened Runtime；已有二进制 entitlement 在重签名时保留。
- 扩展 `scripts/inspect-macos-bundle.mjs`，检查麦克风用途说明及最终签名中的音频采集 entitlement，防止静默回归。

## 验证与边界

- plist 语法、JavaScript 语法和 `git diff --check` 通过。
- 原有应用在新增 entitlement 检查中失败，复现了签名配置缺失。
- 在应用副本上运行最终打包流程；修复副本的 entitlement 检查、深度签名校验和内置 Node/SDK/adapter/protocol 检查通过。
- 完整 DMG/ZIP 打包通过，挂载 DMG 与解压 ZIP 后的签名校验通过。修正签名的测试包保存在 `output/voice-wake-fix/Piko_1.3.1_aarch64.app.zip`；它使用原有 debug 二进制，未重新编译其他源码变更。

## 安装与真人唤醒验证

- 已将修正签名的测试包安装到 `/Applications/Piko.app` 并启动。原版本保存在 `/Users/duanluyao/Library/Application Support/Piko/installation-backups/20261108-180544-voice-wake-fix/Piko.app`。
- 启动日志保存在 `/tmp/piko-wake-installed.stderr.log`，标准输出保存在 `/tmp/piko-wake-installed.stdout.log`。
- 系统麦克风授权完成；应用日志授权状态变为 `3`，TCC 授权记录为 `auth_value=2`（允许）。
- 自动选中 AirPods Pro，输入采样率 24000 Hz，KWS 检测器就绪；后续 RMS 有效值约 0.0005–0.0020，不再持续全零。
- 首次 AirPods 采集流报告设备暂时不可用，worker 已自动重连并恢复采集，未阻断后续测试。
- 真实人声命中唤醒词，录音 5.5 秒，成功转写天气查询，Agent 语音回合 `ok=true`，耗时约 18.9 秒。
- 后续再次命中唤醒词，成功转写待办事项查询，第二轮语音回合 `ok=true`，耗时约 24.1 秒。
- 已验证实际唤醒、录音、转写与两轮完整语音回合，结束后持续监听。扬声器实际听感及连续 24 小时稳定性不在这次短时测试的已验证范围内。
