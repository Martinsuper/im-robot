// 翻页器页面适配器：把蓝牙翻页器作为 Piko 的第五页挂进页面框架。
// 参考 voice_input 的独立模式适配器先例：自建 zone + 全屏 cover，进入页面才启动 BLE。
// 交互（页面锁定时）：上下短按翻页 / OK 短按放映与黑屏 / OK 长按退出页面或放映 /
// 上下长按呼出模式抽屉 / 抽屉内 OK 长按开配对窗口 / 抽屉内 上长按→下长按 清除配对。
#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "bsp_button.h"
#include "ui_controls.h"
#include "lvgl.h"

void pager_page_build(lv_obj_t *screen);   // build_ui 里调用一次（须在 hint/nav 之前）
void pager_page_destroy(void); // Releases UI only; retains BLE/session state.
lv_obj_t *pager_page_zone(void);           // 给 show_zone 用
bool pager_page_open(void);                // PIKO_ENTER：进入页面（首次启动 BLE）
bool pager_page_close(void);               // 离开页面：还原屏幕底色与装饰
// 处理 PIKO_PAGER_* 动作；返回 PIKO_EXIT 表示 OK 长按要求退出页面。
int pager_page_key(int action, bsp_btn_ev_t event);
void pager_page_tick(int64_t now_us);      // 主循环里调用：计时器/闪光/抽屉超时/调暗
// Piko render() 持锁调用：按翻页器状态设置 cover/底色/标题颜色/底部提示并绘制全部内容。
void pager_page_decorate(lv_obj_t *title, lv_obj_t *notice, lv_obj_t *hint, bool page_locked);
void pager_page_set_battery(int percent);  // 转发给 BLE 电量服务（未启动时为空操作）
