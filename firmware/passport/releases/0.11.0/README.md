# Piko Passport 0.11.0（2026-10-25）

保存当前已编译固件，包含音频/蓝牙内存优化、时钟、日历、BLE HID 翻页、配对入口修复及页面操作提示。应用镜像为 2,587,392 字节；芯片 ESP32-C3，8 MB Flash，生产诊断关闭。

## 验证范围

此前版本已实机验证语音输入、蓝牙配对及资源生命周期。本次最终镜像包含新增操作提示，已编译并通过原生回归和 LVGL 几何检查，**尚未刷入设备实测**。原生翻页截图输出异常为全黑，不能作为视觉验收依据，仍需设备屏幕检查。详见仓库 doc/validation/2026-10-25-passport-*.md。

## 恢复此版本

先核对设备与当前分区布局，使用 ESP-IDF Python 环境，仅更新应用：

```sh
python -m esptool --chip esp32c3 --port <串口> --baud 460800 write_flash --flash_mode keep --flash_size keep --flash_freq keep 0x10000 Piko-Passport.bin
```

禁止整片擦除或写入合并镜像。应用分区大小 0x340000；保留 NVS、配对及设备身份区域。归档的 bootloader 和分区表用于版本追溯；已有相同布局的设备无需重写。

manifest.json 记录地址、大小和 SHA-256；sdkconfig 保存本次构建配置；用 `shasum -a 256 -c SHA256SUMS` 校验。未归档设备 Flash 读回、NVS 或个人配对数据。
