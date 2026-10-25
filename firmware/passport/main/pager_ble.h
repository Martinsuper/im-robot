#pragma once
#include "esp_err.h"
#include "pager_keys.h"

typedef enum {
    PAGER_BLE_ADVERTISING = 0,  // 等待配对/回连
    PAGER_BLE_CONNECTED,        // 已连上，还没加密
    PAGER_BLE_READY,            // 已加密，可以发按键
} pager_ble_state_t;

#define PAGER_PEER_NAME_MAX 48  // 对方设备名最多保留的字节数（UTF-8，含结尾 0）

// peer_name 是对方报的设备名（比如 "Alice's MacBook Pro"、"NoteX6"），还没读到时是空串。
typedef void (*pager_ble_state_cb_t)(pager_ble_state_t state, const char *peer_name);

// 启动 BLE HID（键盘 + 媒体键）。state_cb 在 BLE/事件任务里调用，不要阻塞。
esp_err_t pager_ble_start(const char *name, pager_ble_state_cb_t state_cb);
// Stop host, HID event loop and controller; saved bonds are retained.
esp_err_t pager_ble_stop(void);
// 当前连接状态（只读快照，供 UI 轮询）。
pager_ble_state_t pager_ble_state(void);
// 发一次按下 + 松开。连上主机后才发出，返回是否发出。
bool pager_ble_tap(pager_key_t key);
// 更新蓝牙电量服务里的电量（0..100），Mac 和安卓会显示它。
void pager_ble_set_battery(int percent);
// 删除所有已配对设备并断开，重新进入可配对状态。
void pager_ble_forget_all(void);

// —— 演讲控制（都是键盘报告的组合键，仅在 READY 时发出）——
// 启动放映：按次序发 F5（Windows）、Cmd+Shift+Return（macOS）、Cmd+Alt+P，任一平台命中即生效。
void pager_ble_slideshow_start(void);
// 退出放映：Esc。
void pager_ble_slideshow_exit(void);
// 黑屏/恢复：单发 B 键（PowerPoint 与 Keynote 通用）。
void pager_ble_blackscreen_tap(void);

// —— 配对窗口 ——
// 已有绑定后，新设备只在窗口开启期间可配对；首台设备与已绑定设备回连不受限制。
void pager_ble_open_pairing_window(uint32_t ms);
bool pager_ble_pairing_open(void);
int pager_ble_bond_count(void);
