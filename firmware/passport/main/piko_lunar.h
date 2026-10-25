// 万年历推算模块：公历 <-> 农历、节气、干支、传统节日与每日宜忌。
// 数据范围 1901-2100；全部本地推算，无外部依赖，可在 host 与 ESP32 上编译。
#pragma once
#include <stdbool.h>
#include <stddef.h>

#define PIKO_LUNAR_YEAR_MIN 1901
#define PIKO_LUNAR_YEAR_MAX 2100

typedef struct {
  int year, month, day;  // 农历年月日；month 为闰月时 leap 为真，month 仍为原月序
  bool leap;
  char month_cn[20];     // 「九月」「闰六月」「腊月」
  char day_cn[16];       // 「初一」「廿一」「三十」
  char gz_year[8];       // 「丙午」（按农历年，与生肖一致）
  char animal[8];        // 「马」
  char gz_day[8];        // 「辛未」
  int day_gan, day_zhi;  // 日干/日支序位（甲=0…癸=9；子=0…亥=11）
} piko_lunar_date;

// 公历转农历。0 成功；-1 日期无效或超出 1901-2100。
int piko_lunar_from_solar(int y, int m, int d, piko_lunar_date *out);

// 第 n 个节气（1-24，1=小寒）在该公历年的「几号」。错误返回 -1。
int piko_lunar_term_day(int year, int n);

// 某公历日若为节气日，返回节气名（如「霜降」），否则返回 NULL。
const char *piko_lunar_term_on(int y, int m, int d);

// 传统节日名（公历+农历），无节日返回空串。ld 可为 NULL（内部自行换算）。
void piko_lunar_festival(int y, int m, int d, const piko_lunar_date *ld,
                         char *out, size_t n);

// 每日宜忌：建除十二值神推宜忌大类，冲煞由日支推得。
// yi/ji 输出「出行 开市 会亲友」样式；note 输出「冲猪煞东 · 建除「开」」；
// pengzu 输出彭祖百忌「甲不开仓 · 亥不嫁娶」。
void piko_lunar_almanac(int y, int m, int d, const piko_lunar_date *ld,
                        char *yi, size_t yi_n, char *ji, size_t ji_n,
                        char *note, size_t note_n, char *pengzu, size_t pz_n);

// 公历 y-m-d 的月天数（错误 -1）与星期（0=周一 … 6=周日，错误 -1）。
int piko_lunar_solar_days(int y, int m);
int piko_lunar_weekday(int y, int m, int d);
