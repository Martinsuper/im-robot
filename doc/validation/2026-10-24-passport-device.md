# Passport 第一版验证记录

日期：2026-10-24。

## 已验证

- `npm run build`：通过，TypeScript 与 Vite 构建成功。
- `npm run lint`：通过。
- `npm test`：54 个文件、335 项测试通过，含新增设备设置测试。
- `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features devices::tests`：5 项通过，覆盖配对过期、设备绑定凭证、消息大小上限、真实 TCP/WebSocket 交换，以及成功事件去重/失败重试。
- `cargo test --manifest-path src-tauri/Cargo.toml --no-default-features passport_tests`：1 项通过，验证设备不能覆盖运行中或暂停中的计时。
- `cargo run --manifest-path tools/contracts/Cargo.toml -- --check`：通过，216 条命令、151 个 wire 类型。
- `cargo check --manifest-path src-tauri/Cargo.toml --locked`：默认功能检查通过。
- `cargo build --manifest-path src-tauri/Cargo.toml --locked`：默认功能原生桌面可执行文件构建通过；未启动或安装替换现有应用。
- Playwright：Passport 窄窗口设置和原有设置功能共 7 项通过；界面样式调整后重跑 Passport 测试通过。
- 配网门户：以 390 × 844 视口检查表单，验证 JSON 提交与保存反馈；已查看截图。
- ESP-IDF 5.5.3 / ESP32-C3：`idf.py build size` 通过。LVGL 锁定 9.6.0~1，显式设置 24 KB 内存池，蓝牙关闭。
- 固件分段包验证通过：bootloader 21,024 字节、分区表 3,072 字节、应用 1,645,536 字节。应用分区剩余约 52%。包内含各段 SHA-256；没有生成用于整片覆盖的合并镜像。

## 产物

- `firmware/passport/build/piko-passport-0.1.0.zip`（生成目录，不纳入版本控制）。
- `firmware/passport/build/Piko-Passport.bin`。
- 设计、协议及使用说明：`doc/design/07-passport-device-bridge.md`。
- 固件构建、数据保护及按键说明：`firmware/passport/README.md`。

## 尚未验证

没有检测到 Passport USB 串口，未刷写设备。屏幕方向/颜色、动画观感、ADC 按键、电量、真实配网与认证、重连、电脑休眠、运行时剩余堆内存，以及旧固件分区兼容性均需真机验收。分区范围验证只表明打包镜像避开已知身份区，不代表保留所有原有玩法数据。

语音、中文设备字体、提醒同步、自定义形象同步不在本次第一版范围内。
