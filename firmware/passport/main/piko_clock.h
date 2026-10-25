// 时钟表盘纯逻辑：7 段码位表、月相、亮度步进与息屏判定。
// 无 LVGL 依赖，host 与设备共用；绘制在 main.c 中按这里的位表驱动。
#pragma once
#include <stdbool.h>
#include <stdint.h>

#define PIKO_CLK_BRIGHT_LEVELS 5   // 亮度 0..4，0 最暗
#define PIKO_CLK_IDLE_MODES 3      // 0 常亮 1 十分钟 2 两分钟

enum { PIKO_SEG_A, PIKO_SEG_B, PIKO_SEG_C, PIKO_SEG_D, PIKO_SEG_E, PIKO_SEG_F, PIKO_SEG_G, PIKO_SEG_COUNT };

// 数字/符号 → 段位掩码（bit k = PIKO_SEG_k）。code 0-9 为数字，-1 为 '-'。
static inline uint8_t piko_clock_segments(int code) {
  static const uint8_t seg[10] = {0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f};
  if (code == -1) return (uint8_t)(1u << PIKO_SEG_G);
  if (code < 0 || code > 9) return 0;
  return seg[code];
}

// 月相：按公历日期返回 8 相序号（0 新月、2 上弦、4 满月、6 下弦，2000-01-06 新月为基准）。
int piko_clock_moon_stage(int y, int m, int d);

// 亮度步进，输入输出均为 0..4。
static inline uint8_t piko_clock_bright_step(uint8_t level, bool up) {
  if (up) return level < PIKO_CLK_BRIGHT_LEVELS - 1 ? (uint8_t)(level + 1) : (uint8_t)(PIKO_CLK_BRIGHT_LEVELS - 1);
  return level ? (uint8_t)(level - 1) : 0;
}

// 息屏判定：mode 见 PIKO_CLK_IDLE_MODES；inactive_us 为无操作时长。
// 常亮永不息屏；已息屏时返回 false（保持息屏）。
bool piko_clock_should_sleep(uint8_t mode, int64_t inactive_us, bool screen_off);
