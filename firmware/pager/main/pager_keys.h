#pragma once
#include <stdbool.h>
#include <stdint.h>

// 翻页方式：不同设备和阅读软件认的按键不一样，功能键循环切换。
typedef enum {
    PAGER_MODE_ARROW = 0,  // ← / →：Keynote、PowerPoint、大多数阅读器
    PAGER_MODE_PAGE,       // PageUp / PageDown：PPT、网页、部分阅读器
    PAGER_MODE_VOLUME,     // 音量 + / -：文石等安卓阅读器开"音量键翻页"后用
    PAGER_MODE_COUNT,
} pager_mode_t;

typedef enum { PAGER_PREV = 0, PAGER_NEXT } pager_dir_t;

typedef struct {
    uint8_t report_id;  // PAGER_RPT_KEYBOARD 或 PAGER_RPT_CONSUMER
    uint16_t code;      // 键盘 usage（0x07 页）或 consumer usage（0x0C 页）
    uint8_t modifier;   // 键盘报告的修饰键位（Ctrl/Shift/Alt/GUI），普通按键为 0
} pager_key_t;

#define PAGER_RPT_KEYBOARD 1
#define PAGER_RPT_CONSUMER 2

pager_key_t pager_key_for(pager_mode_t mode, pager_dir_t dir);
const char *pager_mode_name(pager_mode_t mode);
const char *pager_mode_hint(pager_mode_t mode);
pager_mode_t pager_next_mode(pager_mode_t mode);
