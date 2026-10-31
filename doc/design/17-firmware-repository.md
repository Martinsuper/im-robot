# 固件独立仓库

2026-10-27 起，ESP32 固件从 `im-robot/firmware/` 拆分为同级独立 Git 仓库。

本机位置：`/Volumes/W_W/claude-workspace/piko-firmware`。

推荐目录结构：

```text
claude-workspace/
├── im-robot/          # Piko 桌面应用
└── piko-firmware/     # ESP32 固件独立仓库
    ├── passport/     # 当前主固件
    ├── pager/        # 历史独立翻页器方案
    └── docs/         # 设备设计和验收记录
```

固件构建说明：[Passport README](../../../piko-firmware/passport/README.md)。固件仓库入口：[Piko Firmware](../../../piko-firmware/README.md)。尚未配置远程仓库，以上链接用于本地并列检出。

桌面端保留设备连接、语音处理、任务执行和授权逻辑；固件仓库负责硬件和设备交互。桌面端已改用 `src-tauri/resources/passport/font-characters.txt`，不再编译时读取固件源码。更新固件字符集时，需要同步审核该兼容性副本。

设备协议见 [接入设计](07-passport-device-bridge.md)。协议变更需要检查新旧桌面端和固件的兼容性。

旧设计和验收记录中的 `firmware/passport/`、`firmware/pager/` 是迁移前路径，分别对应新仓库内的 `passport/`、`pager/`。原构建输出、设备备份和未提交修改均已迁移；旧 CMake 缓存包含原绝对路径，新构建请使用 `build-standalone` 目录。
