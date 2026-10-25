// piko_clock host 测试：段位表、月相锚点、亮度边界、息屏判定。
#include "piko_clock.h"
#include <stdio.h>

static int failures;
#define CHECK(cond, ...) do { if (!(cond)) { failures++; printf("FAIL %s:%d ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)

int main(void) {
  // 段位表：0-9 与 '-'
  CHECK(piko_clock_segments(0) == 0x3f, "seg 0");
  CHECK(piko_clock_segments(1) == 0x06, "seg 1");
  CHECK(piko_clock_segments(8) == 0x7f, "seg 8");
  CHECK(piko_clock_segments(-1) == (1u << PIKO_SEG_G), "seg dash");
  CHECK(piko_clock_segments(99) == 0, "seg invalid");
  // 月相锚点：2000-01-06 新月、2000-01-14 上弦、2000-01-21 满月、2000-01-28 下弦
  CHECK(piko_clock_moon_stage(2000, 1, 6) == 0, "moon new");
  CHECK(piko_clock_moon_stage(2000, 1, 13) == 2 || piko_clock_moon_stage(2000, 1, 14) == 2, "moon first quarter");
  CHECK(piko_clock_moon_stage(2000, 1, 21) == 4, "moon full");
  CHECK(piko_clock_moon_stage(2000, 1, 28) == 6 || piko_clock_moon_stage(2000, 1, 27) == 6, "moon last quarter");
  CHECK(piko_clock_moon_stage(2026, 10, 25) >= 0 && piko_clock_moon_stage(2026, 10, 25) <= 7, "moon range");
  // 亮度：边界与步进
  CHECK(piko_clock_bright_step(2, true) == 3, "bright up");
  CHECK(piko_clock_bright_step(4, true) == 4, "bright clamp top");
  CHECK(piko_clock_bright_step(0, false) == 0, "bright clamp bottom");
  CHECK(piko_clock_bright_step(3, false) == 2, "bright down");
  // 息屏：常亮不息屏；两分钟模式 119s 不睡、121s 睡；已息屏保持
  CHECK(!piko_clock_should_sleep(0, 3600LL * 1000000, false), "always on");
  CHECK(!piko_clock_should_sleep(2, 119LL * 1000000, false), "before 2min");
  CHECK(piko_clock_should_sleep(2, 121LL * 1000000, false), "after 2min");
  CHECK(!piko_clock_should_sleep(1, 599LL * 1000000, false), "before 10min");
  CHECK(piko_clock_should_sleep(1, 601LL * 1000000, false), "after 10min");
  CHECK(!piko_clock_should_sleep(2, 999LL * 1000000, true), "stay off");
  CHECK(!piko_clock_should_sleep(9, 999LL * 1000000, false), "invalid mode");
  if (failures) { printf("%d failures\n", failures); return 1; }
  printf("piko_clock tests passed\n");
  return 0;
}
