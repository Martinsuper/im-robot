# Passport 蓝牙翻页器固件设计

日期：2026-10-24。

## 背景与目标

把 FoloToy AI Passport（ESP32-C3、240×320 ST7789、三枚实体按键、8 MB Flash、无 PSRAM）变成一个 BLE HID 蓝牙翻页器：讲 PPT 时翻幻灯片，看电子书时翻页。设备对电脑、平板、手机和安卓阅读器呈现为标准蓝牙键盘，免驱动、配对即用。

**2026-10-25 修订：改为并入 Piko 固件。** 初版按独立固件设计并已实现（`firmware/pager/`，构建通过），实机刷入验证后确认独立方案不符合预期——设备应保持 Piko 的多页菜单与全部既有功能，翻页器只是其中一个页面。已按 `voice_input` 独立模式适配器的先例并入 `firmware/passport`：

- `main/pager_ble.c/.h`、`main/pager_keys.c/.h`：NimBLE HID 模块原样迁入（双报告描述符、配对窗口、放映组合键）。
- `main/pager_page.c/.h`：页面适配器。自建 zone 与全屏 cover（盖住状态栏/标题，压在提示与导航之下），首次进入页面才启动 BLE（`pager_ble_start` 一次，之后常驻）；模式存 NVS namespace `pager`。
- 路由：`ui_controls.h` 增加 `PIKO_PAGER` 页与六个动作，锁定态按键策略见表；`main.c` 挂入 ENTER / 翻页 / 分发 / 10ms tick / 电量转发。
- 共存实测（构建期）：应用 2.54 MB（分区 3.25 MB，余 0.7 MB）；静态 DRAM 221 KB / 321 KB，剩 100 KB，NimBLE 运行时堆约 40–60 KB，**与语音功能的运行时共存需实机验证**。
- `firmware/pager/` 保留独立固件版本作为参照，不再刷机使用。

## 参考项目与取舍

已逐个阅读源码（克隆于 2026-10-24），取舍如下：

| 项目 | 吸收 | 不吸收 |
| --- | --- | --- |
| [passport-pager](https://github.com/Gchen961/passport-pager)（Gchen961） | NimBLE + `esp_hidd` 双报告描述符；三种翻页模式 + NVS 持久化；读对端 GAP 设备名；BLE 电量上报；4 台绑定记忆与自动回连；Repeat Pairing 处理；事件队列主循环；字体子集缺字检查；OTA trial-boot 确认 | 无 |
| [ai-passport-ppt](https://github.com/YeatsLiao/ai-passport-ppt)（YeatsLiao） | OK 键启动/退出放映的跨平台组合键（F5 / Cmd+Shift+Return 等）；演讲计时器；按键即时反馈文案 | Bluedroid 协议栈（内存占用高于 NimBLE 一倍以上）；纯英文 UI |
| [moyu-badge](https://github.com/fakechris/moyu-badge)（fakechris） | HID 传输层抽象（固件/模拟器两套实现，CMake 选择）；SDL 桌面模拟器与 headless 自测（`--script` + `--shot`）；配对窗口（非窗口期拒绝新绑定，防陌生设备抢配）；演示模式超时调暗不退出；发送/丢弃计数 | 五模式应用外壳（本项目单功能，不需要） |
| [ai-passport-tiktok-remote](https://github.com/YeatsLiao/ai-passport-tiktok-remote) | 与 ai-passport-ppt 同源，无新增；仅确认媒体键（Consumer Control）在真实主机上的可用性 | 无 |

社区另有两个同类固件（#1233 蓝牙PPT翻页笔、#971 蓝牙ppt翻页笔2）无源码，仅作功能对照。

## 总体架构

```
firmware/pager/
  CMakeLists.txt
  partitions.csv
  sdkconfig.defaults
  prepare.py            # 固定官方 BSP 到与 Piko 相同的提交 006c2279，存入 vendor/
  package.py            # 校验镜像并打分段刷写包（沿用 Piko 的做法）
  main/
    main.c              # 事件队列主循环（取自 passport-pager）
    ble_hid.c/.h        # NimBLE HID 设备：报告描述符、GAP、配对、电量服务
    hid_transport.h     # 传输层接口：send_key / connected / battery 等（取自 moyu-badge 的 clicker_hid.h 思路）
    keys.c/.h           # 模式 → HID 键值映射；放映组合键序列
    ui_home.c/.h        # 主界面（LVGL）
    fonts/              # 思源黑体中文子集（工具生成）
    font-characters.txt # 界面用字清单
  sim/
    main.c              # SDL 240×320 窗口 + 键盘当按键（取自 moyu-badge）
    stubs/              # nvs/esp_log/bsp_* 等宿主桩
    CMakeLists.txt      # 宿主构建：LVGL + stubs + main 源文件，BLE 用 log-only 实现
  tools/gen_fonts.sh    # fontTools 按用字清单生成子集字体
```

线程模型与 passport-pager 一致：

- NimBLE host 任务（由 `nimble_port_freertos_init` 启动），只处理蓝牙协议栈；状态变化与对端设备名通过回调投递事件。
- 主循环 `app_main`：`xQueueReceive` 阻塞等待按键事件与 BLE 状态事件，所有 LVGL 绘制都在主循环内持锁完成。LVGL 锁由 BSP 提供（`bsp_lvgl_lock/unlock`）。
- 按键回调由 BSP 按键驱动触发，只做事件入队，不做任何 UI 或蓝牙操作。

事件类型：`EV_PREV`、`EV_NEXT`、`EV_OK_CLICK`、`EV_OK_DOUBLE`、`EV_OK_LONG`、`EV_COMBO`（清除配对组合手势）、`EV_BLE`（状态 + 对端名）。

## BLE HID 设计

### 报告描述符

两个报告（与 passport-pager 相同）：

- Report ID 1：标准键盘。8 bit 修饰键 + 1 bit 保留 + 5 bit LED 输出 + 6 个键值槽。
- Report ID 2：Consumer Control。一个 16 bit usage，用于音量键。

`vendor_id = 0x16C0`、`product_id = 0x05DF`、appearance `0x03C1`（Keyboard），广播携带完整设备名与 HID 16-bit UUID。广播间隔 30–50 ms，通用可发现、不支持 BR/EDR。

### 配对与安全

- `sm_io_cap = NO_IO`（无屏幕输入的直接配对，不弹 PIN）；Secure Connections 开启；MITM 关闭。这是所有参考项目共同采用的方案，代价是链路不防中间人，用配对窗口缓解（下条）。
- **配对窗口规则**（取自 moyu-badge 并放宽）：
  - 设备从未有过绑定时，永远开放配对——保证开箱即用；
  - 已有绑定后，仅在"配对窗口"开启期间接受新配对。进入窗口的方式：双击 OK 进入模式切换页时长按 OK（见按键表），窗口 2 分钟，超时自动关闭；
  - 已绑定设备回连不受窗口限制。
- 绑定与密钥存 NVS（`ble_store_config_init` + `ble_store_util_status_rr`），最多保留 4 台；第 5 台配对时按最久未用淘汰（NimBLE store 回调内处理）。
- Repeat Pairing：对端删除配对后重新配时，`ble_store_util_delete_peer` 丢弃旧密钥并 `RETRY`，避免卡死在拒绝状态（照搬 passport-pager）。
- 清除所有配对：主动断开连接 + `ble_store_clear()`，UI 显示"配对已清除"。

### 连接状态机

`ADVERTISING`（未连接，广播中）→ `CONNECTED`（已连上、加密协商中）→ `READY`（链路已加密，可发键）。

- 加密完成后通过 GATT 读对端 GAP 服务 0x2A00 设备名，UTF-8 安全截断（不切开多字节字符），主界面显示"已连接到 xxx"。有的主机只在加密后才允许读，所以读名字放在 `ENC_CHANGE` 成功之后。
- 断开后立即重新广播；连接失败也回到广播。
- 状态、对端名通过 `EV_BLE` 事件送主循环刷新 UI；不发键时无任何周期性活动（省电依赖 BLE 连接参数，由主机侧协商）。

### 电量

每 30 s 读一次 `bsp_battery_soc()`，变化才上报：`esp_hidd_dev_battery_set()` + UI 刷新。启动时先报 100%，读到真实值前不触发电脑低电量提示。低于 15% UI 变红。

## 按键与模式

### 翻页模式（取自 passport-pager）

| 模式 | 上键 | 下键 | HID 报告 | 适用 |
| --- | --- | --- | --- | --- |
| 方向键（默认） | ← (0x50) | → (0x4F) | 键盘 Report 1 | Keynote、PowerPoint、多数阅读器 |
| 翻页键 | PageUp (0x4B) | PageDown (0x4E) | 键盘 Report 1 | PPT、网页、部分阅读器 |
| 音量键 | 音量+ (0xE9) | 音量− (0xEA) | Consumer Report 2 | 文石等安卓阅读器（需开"音量键翻页"） |

当前模式存 NVS（namespace `pager`，key `mode`），断电记忆。模式切换时 UI 的模式 chip 高亮刷新并显示该模式的一句话提示。

### 演讲功能（取自 ai-passport-ppt 与 moyu-badge）

- **启动放映**：OK 短按。组合键按次序轮发，间隔 200 ms，任一平台命中即生效（照搬 ppt 的兼容策略）：
  1. `F5`（Windows PowerPoint / WPS / LibreOffice）
  2. `LeftGUI + LeftShift + Return`（macOS Keynote）
  3. `LeftGUI + LeftAlt + P`（部分放映软件）
- **放映中 OK 短按**：黑屏/恢复（发 `B` 键，PowerPoint 与 Keynote 通用；moyu-badge 的 presenter 友好功能）。
- **退出放映**：OK 长按，发 `Esc`，计时器停止并归零。
- **演讲计时器**：启动放映时清零并开始，主界面大号显示 `MM:SS`（超过 1 小时 `HH:MM:SS`），每秒刷新；退出放映停止但保留读数，再次启动重新清零（ppt 的规则：仅首次启动，重复按不重置）。
- **键值发送**：press 后保持 120 ms 再 release（含组合键），同一报告先发全零清空；未连接时按键不发送，UI 显示"未连接，先在蓝牙里配对"。
- 计数器：累计已发送键数与未连接丢弃数（moyu-badge），放在长按 OK 的信息页，正常使用不出现。

### 按键表

| 按键 | 操作 | 效果 |
| --- | --- | --- |
| 上 / 下 | 短按 | 上一页 / 下一页（按当前模式发键） |
| OK | 短按 | 未放映：启动放映并开始计时；放映中：黑屏/恢复 |
| OK | 长按 | 退出放映（Esc + 停止计时）；未放映时无动作 |
| OK | 双击 | 呼出模式抽屉（三模式选择，不再单击轮换，避免演讲中误切） |
| 模式抽屉内 OK 长按 | 长按 | 开启 2 分钟配对窗口 |
| 上长按 → 下长按 | 组合手势 | 清除所有配对（ppt 的防误触姿势，需在 2 s 内完成先后长按） |

单击/双击/长按的识别依赖 BSP 按键驱动（`bsp_button_init` 回调事件 `BSP_BTN_CLICK`/`BSP_BTN_DOUBLE`/`BSP_BTN_LONG`）。已知约束：单击要等驱动排除双击才发出，翻页键不经过这条路径（上/下键直接用 PRESS 事件），仅 OK 键承担三态，延迟可接受。

## UI 设计（v2，状态主导）

单页固件（LVGL，240×320），主题与 Piko 固件同一套（米纸底 `#f6f1e7`、墨绿 `#315446`、强调绿 `#315e49`、白卡片 + `#e3e5d8` 描边），不引入底部页面导航——它是单品工具，不是多页系统。v2 的核心原则：**五种状态在版式与配色上结构各异，不读字就能分辨**。

- **引导态（等待配对/回连）**：大蓝牙徽标（48 px，琥珀色）+ "等待配对" + 一张连接步骤卡片（"打开电脑或手机的蓝牙设置，选择 Passport Pager 连接"），底部一行"无需配对码，配对一次自动记住"。唯一教学时刻，其余信息全部让位。
- **主态（已连接）**：屏幕中央只回答"现在是什么模式"——48 px 大方向键符号（翻页键/音量键模式显示 `PgUp / PgDn`、`音量 + / -`）+ 24 px 模式名 + 一行适配提示。连接状态缩成顶部一行小字（蓝牙图标 + 对端设备名 + 电量），不再有整行状态文字和页面标题。
- **按键闪光带**：翻页时主态下部弹出绿色描边圆角带，大字显示"下一页"/"上一页"（未连接时琥珀色"未连接，先在蓝牙里配对"），800 ms 后淡出——远距离可见的按键反馈。
- **放映接管态**：OK 短按启动放映后**整页反色**（墨绿底 `#22332b` + 奶油字），52 px 等宽数字计时器 + "放映中"琥珀胶囊 + "OK 黑屏　长按 退出"提示。状态切换从换文字变成换配色。
- **黑屏态**：放映中再按 OK，主机黑屏，设备近乎全黑（`#0e1512`）只剩一枚呼吸点和 35% 透明度的"已黑屏　按 OK 恢复"。观众侧无内容，设备同时省电；黑屏中上下键不翻页（语义不明），OK 恢复。
- **模式抽屉**：OK 双击在主态上压一层 30% 墨绿蒙层 + 底部抽屉（三模式行，选中行打勾高亮，右侧键位标签），OK 确认即回，5 秒无操作自动收起；**抽屉内长按 OK 开启 2 分钟配对窗口**（配对窗口入口收进抽屉，不再占独立页面）。
- **清除配对**：上长按 → 下长按（2 s 内）组合手势，屏幕闪现"配对已清除"并回到引导态。
- **调暗规则**（moyu-badge）：放映中 120 s 无操作调至 6% 亮度、非放映 60 s 调至 20%，任何按键恢复；**不退出放映模式**。
- **字体**：沿用现有子集（16 px 正文 / 24 px 大字，GB2312 一级字兜底，覆盖全部界面文案；文案避开字库缺的间隔号 `·`）+ montserrat 48 px（计时器、箭头、蓝牙徽标）。启动时逐字检查缺字并记日志。

## 数据与持久化

全部在 NVS，无文件系统：

- namespace `pager`：`mode`（u8，翻页模式）。
- namespace `nimble_bond`（NimBLE 默认）：绑定密钥，由 `ble_store` 管理，容量 4 台。

不保存对端名（每次连接现读）、不保存计时器状态。NVS 初始化失败不擦除、不重启，只记日志并降级为"配对与模式不记忆"（passport-pager 的容错策略）。

## 模拟器与测试

取自 moyu-badge，目标是不碰硬件就能开发 UI 和逻辑：

- `sim/` 用 SDL 起 240×320 窗口，键盘映射按键（↑/↓ = 上/下，Enter/Space = OK，长按 >0.9 s 识别为长按），`ble_hid` 链接 log-only 实现（打印发送的键值）。
- 所有与 BSP 交互走 `hid_transport.h` 与 BSP 头文件，宿主构建用 `sim/stubs/` 桩替换；`sdkconfig` 差异用 `CONFIG_PAGER_SIM_NO_BLE` 隔离（照搬 passport-pager）。
- headless 自测：`sim/pager-sim --script "down down ok wait:6000 shot:/tmp/home.rgb565"`，脚本 token：`up` `down` `ok` `okl`（长按） `wait:MS` `shot:路径`。CI 或提交前跑一遍主流程截图比对（人工看图，先不做像素 diff）。
- 实机测试清单：Mac（Keynote 方向键 + Cmd+Shift+Return）、Windows（PowerPoint F5）、安卓（文石音量键模式）、iPhone（Keynote 远程控制场景）、双设备切换、断电回连、低电上报。

## 构建与发布

- ESP-IDF 5.5.3（与 Piko 固件一致），`prepare.py` 把官方 BSP 固定到同一提交 `006c2279`，LVGL 锁定 `9.6.0~1`。
- 分区表：沿用小智兼容布局（ota_0 / ota_1 各 3 MB，与 passport-pager 相同），发布两个镜像：
  - `pager-merged.bin`：整片写入（覆盖现有玩法，README 要求先整片备份）；
  - `pager-app.bin`：写 OTA_1（`0x310000`）+ 改写启动记录，可与小智共存（文档给带校验的步骤；应用内保留 trial-boot 确认，`esp_ota_mark_app_valid_cancel_rollback`）。
- `package.py` 校验芯片型号与写入边界、输出带 SHA-256 清单的 zip，不连接设备——与 Piko 固件相同的发布纪律。
- **刷写纪律沿用仓库约定：本仓库的修改不自动刷写设备；写前确认串口与分区、备份、取得用户授权；禁止整片擦除。**

## 里程碑

1. **M1 基础翻页**：项目骨架 + NimBLE HID 双报告 + 三模式 + 中文 UI + NVS 记忆，Mac/Windows 实机配对验证。
2. **M2 演讲功能**：放映组合键、计时器、黑屏、退出，接入事件队列。
3. **M3 体验与安全**：配对窗口、清除配对手势、发送/丢弃计数、调暗规则、电量上报与对端名。
4. **M4 模拟器**：SDL 模拟器 + headless 脚本 + 字体生成工具入仓。
5. **M5 发布**：merged/app 双镜像、README（含 OTA_1 共存步骤）、tag 发布。

## 风险与开放问题

- **OK 键三态时序**：BSP 驱动的 CLICK/DOUBLE/LONG 事件粒度与延迟需实测；若长按阈值过钝，M2 时评估在 `ble_hid` 层之上自建轻量按键状态机（用 PRESS/RELEASE 原始事件自行计时）。
- **组合键兼容性**：ppt 的三种启动组合键覆盖主流场景但非全部（如 WPS 某些版本用 `Shift+F5` 放映，此组合暂不实现，列入实机测试清单观察）。
- **内存**：NimBLE + HID + LVGL 在 C3 上可用但余量有限；构建后核对 `idf.py size`，必要时关 LVGL 的多余控件与动画。
- **NO_IO 配对的安全性**：无输入配对意味着附近设备可配对冒充键盘；配对窗口把暴露面缩小到"从未绑定"与"2 分钟窗口"两类时刻，与参考项目相比更严格，但不解决中间人问题。
- **音量键模式的副作用**：音量键会真实改变电脑音量（iOS Keynote 无音量键翻页），UI 提示里说明。

## 实测待验证

- Wi-Fi + BLE 共存下语音输入（UDP 录音流）与 Piko WebSocket 的时延与稳定性。
- OK 单击/双击/长按时序在 Piko 按键框架下的手感；上下长按呼出抽屉前会发生一次翻页（与日历页长按连翻同款副作用，需实测接受度）。
- 放映组合键在 Keynote / PowerPoint 的命中率；配对窗口的拒绝行为。
