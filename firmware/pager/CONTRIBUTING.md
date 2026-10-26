# 参与贡献 · Contributing

欢迎任何形式的贡献：报告问题、提功能建议、改代码、补文档。English contributions are welcome too.

## 开发环境

- ESP-IDF **5.5.3**（`idf_component.yml` 锁定了 `>=5.5.3,<5.6.0`，用别的版本可能编不过）
- 一块 FoloToy AI Passport，或者 [PassportSim](https://github.com/BlackHole1/passportsim) 模拟器
- 改中文文案时需要 Node.js 和 `lv_font_conv@1.5.2`

```sh
. ~/esp/esp-idf-v5.5.3/export.sh
idf.py build
```

## 提交前检查

1. **构建通过**：`idf.py build` 成功，不引入新的编译警告。GitHub Actions 会在每个 PR 上用 `espressif/idf:v5.5.3` 从零构建一遍。
2. **实际验证**：在真机或 PassportSim 上跑一遍你改的功能，PR 里写清楚怎么验证的，最好附截图。
3. **配置改动写进 `sdkconfig.defaults`**：`sdkconfig` 是构建生成的，不进仓库，只在 menuconfig 里改，别人拿不到。
4. **中文文案改了就重新生成字体**：

   ```sh
   LV_FONT_CONV=./node_modules/.bin/lv_font_conv tools/gen_fonts.sh
   ```

   然后看启动日志里的 `Glyph check: 0 of N glyphs missing`，必须是 0。

## 在模拟器里测试

```sh
passportsim start "$(pwd)/build"
passportsim run --for 2s
passportsim input ok click                # 切换模式
passportsim screenshot --save-as after    # 截图
passportsim ble_connect --service 1812    # 模拟蓝牙主机连上
passportsim input down click
passportsim ble_gatt notifications        # 应该收到 00 00 4f …（→）
passportsim stop p1
```

同时开了多个实例时，在命令后加 `--instance <id>`（`passportsim status` 能查到 id）。

PassportSim 只认 IDF 5.5.3 编的蓝牙固件，而且要求镜像里有 `esp_bt_controller_disable` / `esp_bt_controller_deinit`，所以 `main/pager_ble.c` 里特意保留了对它们的引用，不要删。

如果只想测界面、不需要蓝牙，可以用模拟器专用的配置编一个跳过蓝牙的版本（不要烧到真机）：

```sh
idf.py -B build-sim -D SDKCONFIG=build-sim/sdkconfig -D "SDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.sim" build
```

## 代码约定

- 注释和界面文案用中文，标识符和日志用英文。
- 和板子相关的引脚、电压阈值都在 `components/bsp/include/bsp_pins.h`，那是 FoloToy 官方 BSP，尽量不改；需要改时在 PR 里说明原因。
- 不要在 NVS 里擦除或改写不属于本项目的命名空间：真机上的 NVS 和出厂小智共用。
- 一个 PR 只做一件事，提交说明用英文、说清楚改了什么和为什么。

## 报告问题

请用 Issue 模板，写上：板子和固件版本、连接的设备（比如 macOS 15、文石 NoteX6）、复现步骤，以及串口日志（`idf.py monitor` 的输出）。
