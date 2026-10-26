# Passport Pager · AI Passport 蓝牙翻页器

**中文** · [English](README.en.md)

把 [FoloToy AI Passport](https://github.com/FoloToy/ai-passport)（ESP32-C3 电子胸牌）变成一个蓝牙翻页器：给 Mac 上的 Keynote / PowerPoint 翻幻灯片，给文石等电子书阅读器翻页。不用装驱动，配对一次，以后开机自动回连。

![PassportSim 里的界面：待配对、翻页、三种模式、忘记配对确认](docs/images/screens.png)

<sub>截图来自 [PassportSim](https://github.com/BlackHole1/passportsim) 模拟器。</sub>

## 功能

- **三种翻页方式**，按功能键切换，断电后也记得：

  | 模式 | 上键 | 下键 | 适合 |
  | --- | --- | --- | --- |
  | 方向键 | ← | → | Keynote、PowerPoint、多数阅读器 |
  | 翻页键 | PageUp | PageDown | PPT、网页、部分阅读器 |
  | 音量键 | 音量 + | 音量 − | 文石等安卓阅读器（需在阅读器里打开"音量键翻页"） |

- **标准蓝牙键盘**（BLE HID）：Mac、Windows、安卓都能直接配对，不用装任何软件。
- **显示连接对象**：配对后屏幕上显示"已连接到 NoteX6"这样的对方设备名。
- **右上角状态栏**：蓝牙连接状态（灰 = 未连接，蓝 = 正在连接，绿 = 已连接）和电量百分比，电量低于 15% 变红。
- **电量同步给电脑**：通过蓝牙电量服务上报真实电量，Mac 的蓝牙菜单里能看到。
- **记住最多 4 台设备**，开机自动回连上次的设备。
- 全中文界面，字体按界面实际用到的字从思源黑体生成，另含 GB2312 一级常用字，用来显示中文设备名。

## 按键

| 按键 | 操作 |
| --- | --- |
| 上键 | 上一页 |
| 下键 | 下一页 |
| 功能键 单击 | 切换翻页方式 |
| 功能键 双击 | 弹出"忘记配对？"，5 秒内再按功能键清除所有配对，按上 / 下键取消 |

## 使用

1. 烧录固件（见下一节）。
2. 在电脑或阅读器的蓝牙设置里找到 **Passport Pager**，点连接。不需要输配对码。
3. 屏幕显示"已连接到 xxx"、右上角蓝牙图标变绿，就可以翻页了。

**文石**：在 NeoReader 的设置里打开"音量键翻页"，再把翻页器切到"音量键"模式。也可以先试"方向键"模式。

**换设备**：翻页器同一时间只连一台。在当前设备上断开蓝牙，翻页器会重新广播，另一台设备就能连上。

## 烧录

> ⚠️ 烧录前请先备份整片 Flash。AI Passport 出厂带小智语音助手，下面方式一会覆盖它。

**方式一：整片烧录（最简单）**

从 [Releases](https://github.com/Gchen961/passport-pager/releases/latest) 下载 `passport-pager-merged.bin`，然后：

```sh
# 先备份整片 8MB Flash
esptool.py --chip esp32c3 read-flash 0 0x800000 passport-backup.bin
# 整片写入
esptool.py --chip esp32c3 write-flash 0x0 passport-pager-merged.bin
```

也可以用 FoloToy 官方的网页烧录工具写入合并镜像。

**方式二：保留小智，只写 OTA_1**

本项目的分区表和小智一致（ota_0 / ota_1 各 3MB）。只把应用写进 OTA_1（`0x310000`），再把第二个启动记录（`0xe000`）指向 OTA_1，小智就留在 OTA_0。翻页器第一次启动是"试启动"，启动失败会自动退回小智。

Releases 里的 `passport-pager-app.bin` 就是写进 OTA_1 的应用。这种方式要手工改启动记录，写错扇区会导致无法启动，带校验的详细步骤还在编写中，欢迎贡献。

## 从源码构建

需要 **ESP-IDF 5.5.3**（FoloToy 官方 BSP 要求 `>=5.5.3,<5.6.0`）。

```sh
git clone https://github.com/Gchen961/passport-pager.git
cd passport-pager
. ~/esp/esp-idf-v5.5.3/export.sh
idf.py build                          # 应用：build/passport_pager.bin（约 1.6MB）
idf.py merge-bin -o merged.bin        # 整片镜像：build/merged.bin
```

配置都在 `sdkconfig.defaults` 里，`sdkconfig` 是构建时自动生成的，不进仓库。改配置请改 `sdkconfig.defaults`。

## 不用板子，在模拟器里试

[PassportSim](https://github.com/BlackHole1/passportsim) 能模拟 AI Passport 的屏幕、按键和蓝牙：

```sh
passportsim start "$(pwd)/build"          # 启动，路径要写绝对路径
passportsim screenshot --save-as home     # 截屏
passportsim input down click              # 按下键
passportsim ble_connect --service 1812    # 用模拟的蓝牙主机连上翻页器
passportsim ble_gatt notifications        # 看收到的按键报告，比如 00 00 4f = →
```

同时开了多个实例时，在命令后加 `--instance p1` 指定。PassportSim 的蓝牙模拟只支持 IDF 5.5.3 编出来的固件。它的测试主机不做配对，所以模拟器里状态一直是"正在连接…"，看不到设备名。

也可以用乐鑫的 [esp-emulator](https://github.com/espressif/esp-emulator) 验证启动和蓝牙广播。

## 修改界面文字

界面用的中文字体是从思源黑体里按需挑字生成的。改了 `main/` 里的中文文案后，要重新生成字体：

```sh
npm install lv_font_conv@1.5.2           # LVGL 官方字体转换工具
LV_FONT_CONV=./node_modules/.bin/lv_font_conv tools/gen_fonts.sh
```

启动日志里有一行 `Glyph check: 0 of N glyphs missing`，不是 0 就说明有字没生成进去。

## 项目结构

```
main/
  main.c           界面、按键、状态栏、电量
  pager_ble.c/h    蓝牙 HID：广播、配对、发按键、读对方设备名、电量服务
  pager_keys.c/h   三种翻页方式对应的按键码
components/bsp/    FoloToy 官方板级支持包（屏幕、按键、电量计等）
assets/fonts/      生成的中文字体和字符清单
tools/gen_fonts.sh 字体生成脚本
partitions.csv     与出厂小智一致的分区表
```

## 已知限制

- 同一时间只能连一台设备，切换要先在当前设备上断开。
- 电量每 30 秒刷新一次。
- 音量键模式在 Mac 上会真的调音量，Mac 请用方向键模式。

## 参与贡献

欢迎提 Issue 和 PR。下面这些想法还没做，适合上手：

- [ ] 长按功能键在两台已配对设备之间切换
- [ ] 拍照模式（音量 + 作为手机相机快门）
- [ ] 媒体键模式（上一首 / 下一首 / 播放暂停）
- [ ] 短视频模式（模拟上滑手势）
- [ ] 一段时间不用自动息屏省电

提交前请：

1. 用 IDF 5.5.3 构建通过；
2. 在 PassportSim 或真机上验证改动；
3. 改了中文文案就重新生成字体，并确认 `Glyph check` 为 0。

详细说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

本项目以 [MIT](LICENSE) 许可证发布。

包含的第三方内容：

- `components/bsp/`：来自 [FoloToy/ai-passport](https://github.com/FoloToy/ai-passport)，MIT 许可证，见 [components/bsp/LICENSE](components/bsp/LICENSE)。
- `assets/fonts/`：由 [思源黑体 Source Han Sans](https://github.com/adobe-fonts/source-han-sans) 生成的子集，SIL Open Font License 1.1，见 [LICENSE-SourceHanSans.txt](assets/fonts/LICENSE-SourceHanSans.txt)。
- 蓝牙 HID 的初始化流程参考了 ESP-IDF 示例 `esp_hid_device`（Unlicense / CC0-1.0）。

## 致谢

- [FoloToy](https://github.com/FoloToy) 开源的 AI Passport 硬件资料和 BSP
- [PassportSim](https://github.com/BlackHole1/passportsim) 和 [esp-emulator](https://github.com/espressif/esp-emulator)，让没有板子也能开发调试
- [LVGL](https://lvgl.io) 和 [lv_font_conv](https://github.com/lvgl/lv_font_conv)
