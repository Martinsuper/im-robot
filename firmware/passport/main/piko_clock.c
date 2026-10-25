// 时钟表盘纯逻辑实现，见 piko_clock.h。
// 段位表与通行 7 段码一致；月相以 2000-01-06 18:14 UTC 朔月为基准、朔望月
// 29.53059 日循环（日期粒度足够 14px 装饰盘显示）。
#include "piko_clock.h"

#include <math.h>

// 天数自 1970-01-01（Howard Hinnant days_from_civil）。
static long clk_days_from_civil(long y, unsigned m, unsigned d) {
  y -= m <= 2;
  const long era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = (unsigned)(y - era * 400);
  const unsigned doy = (153u * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + (long)doe - 719468;
}

int piko_clock_moon_stage(int y, int m, int d) {
  if (y < 1901 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return 0;
  const double synodic = 29.53059;
  long days = clk_days_from_civil(y, (unsigned)m, (unsigned)d) - clk_days_from_civil(2000, 1, 6);
  double phase = (days + 0.764) / synodic;  // 18:14 UTC ≈ 0.76 日
  phase -= (long)phase;
  if (phase < 0) phase += 1;
  return (int)(phase * 8 + 0.5) % 8;
}

bool piko_clock_should_sleep(uint8_t mode, int64_t inactive_us, bool screen_off) {
  if (screen_off || mode == 0 || mode >= PIKO_CLK_IDLE_MODES) return false;
  int64_t timeout = mode == 1 ? 600LL * 1000000 : 120LL * 1000000;
  return inactive_us >= timeout;
}
