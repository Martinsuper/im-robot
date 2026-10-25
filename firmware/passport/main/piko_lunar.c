// 万年历推算实现，见 piko_lunar.h。
// 农历换算与节气日期的位表数据来自 solarlunar（ISC License），算法按其
// 公开实现移植：日干支以 1970-01-01（甲戌）为锚，彭祖百忌/建除/冲煞为
// 通行民俗口诀，仅作参考展示。
#include "piko_lunar.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

// 农历月序/大小/闰月位表与 24 节气日期速查表（1900-2100）。
// 来源：solarlunar (ISC License, https://www.npmjs.com/package/solarlunar)，
// 与广泛流传的开源万年历数据一致；按 ISC 许可注明来源后嵌入。
static const uint32_t lunar_info[201] = {
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260,  // 1900-1904
  0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,  // 1905-1909
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255,  // 1910-1914
  0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,  // 1915-1919
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40,  // 1920-1924
  0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,  // 1925-1929
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0,  // 1930-1934
  0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,  // 1935-1939
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4,  // 1940-1944
  0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,  // 1945-1949
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0,  // 1950-1954
  0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0,  // 1955-1959
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570,  // 1960-1964
  0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,  // 1965-1969
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4,  // 1970-1974
  0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6,  // 1975-1979
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a,  // 1980-1984
  0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,  // 1985-1989
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50,  // 1990-1994
  0x06b58, 0x05ac0, 0x0ab60, 0x096d5, 0x092e0,  // 1995-1999
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552,  // 2000-2004
  0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,  // 2005-2009
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9,  // 2010-2014
  0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,  // 2015-2019
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60,  // 2020-2024
  0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,  // 2025-2029
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0,  // 2030-2034
  0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,  // 2035-2039
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577,  // 2040-2044
  0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,  // 2045-2049
  /**Add By JJonline@JJonline.Cn**/
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0,  // 2050-2054
  0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0,  // 2055-2059
  0x092e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0,  // 2060-2064
  0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,  // 2065-2069
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6,  // 2070-2074
  0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,  // 2075-2079
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50,  // 2080-2084
  0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,  // 2085-2089
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0,  // 2090-2094
  0x04ae0, 0x0a9d4, 0x0a4d0, 0x0d150, 0x0f252,  // 2095-2099
  0x0d520,  // 2100-2100
};

static const char *const term_info[201] = {
  "9778397bd097c36b0b6fc9274c91aa", "97b6b97bd19801ec9210c965cc920e",  // 1900-1901
  "97bcf97c3598082c95f8c965cc920f", "97bd0b06bdb0722c965ce1cfcc920f",  // 1902-1903
  "b027097bd097c36b0b6fc9274c91aa", "97b6b97bd19801ec9210c965cc920e",  // 1904-1905
  "97bcf97c359801ec95f8c965cc920f", "97bd0b06bdb0722c965ce1cfcc920f",  // 1906-1907
  "b027097bd097c36b0b6fc9274c91aa", "97b6b97bd19801ec9210c965cc920e",  // 1908-1909
  "97bcf97c359801ec95f8c965cc920f", "97bd0b06bdb0722c965ce1cfcc920f",  // 1910-1911
  "b027097bd097c36b0b6fc9274c91aa", "9778397bd19801ec9210c965cc920e",  // 1912-1913
  "97b6b97bd19801ec95f8c965cc920f", "97bd09801d98082c95f8e1cfcc920f",  // 1914-1915
  "97bd097bd097c36b0b6fc9210c8dc2", "9778397bd197c36c9210c9274c91aa",  // 1916-1917
  "97b6b97bd19801ec95f8c965cc920e", "97bd09801d98082c95f8e1cfcc920f",  // 1918-1919
  "97bd097bd097c36b0b6fc9210c8dc2", "9778397bd097c36c9210c9274c91aa",  // 1920-1921
  "97b6b97bd19801ec95f8c965cc920e", "97bcf97c3598082c95f8e1cfcc920f",  // 1922-1923
  "97bd097bd097c36b0b6fc9210c8dc2", "9778397bd097c36c9210c9274c91aa",  // 1924-1925
  "97b6b97bd19801ec9210c965cc920e", "97bcf97c3598082c95f8c965cc920f",  // 1926-1927
  "97bd097bd097c35b0b6fc920fb0722", "9778397bd097c36b0b6fc9274c91aa",  // 1928-1929
  "97b6b97bd19801ec9210c965cc920e", "97bcf97c3598082c95f8c965cc920f",  // 1930-1931
  "97bd097bd097c35b0b6fc920fb0722", "9778397bd097c36b0b6fc9274c91aa",  // 1932-1933
  "97b6b97bd19801ec9210c965cc920e", "97bcf97c359801ec95f8c965cc920f",  // 1934-1935
  "97bd097bd097c35b0b6fc920fb0722", "9778397bd097c36b0b6fc9274c91aa",  // 1936-1937
  "97b6b97bd19801ec9210c965cc920e", "97bcf97c359801ec95f8c965cc920f",  // 1938-1939
  "97bd097bd097c35b0b6fc920fb0722", "9778397bd097c36b0b6fc9274c91aa",  // 1940-1941
  "97b6b97bd19801ec9210c965cc920e", "97bcf97c359801ec95f8c965cc920f",  // 1942-1943
  "97bd097bd07f595b0b6fc920fb0722", "9778397bd097c36b0b6fc9210c8dc2",  // 1944-1945
  "9778397bd19801ec9210c9274c920e", "97b6b97bd19801ec95f8c965cc920f",  // 1946-1947
  "97bd07f5307f595b0b0bc920fb0722", "7f0e397bd097c36b0b6fc9210c8dc2",  // 1948-1949
  "9778397bd097c36c9210c9274c920e", "97b6b97bd19801ec95f8c965cc920f",  // 1950-1951
  "97bd07f5307f595b0b0bc920fb0722", "7f0e397bd097c36b0b6fc9210c8dc2",  // 1952-1953
  "9778397bd097c36c9210c9274c91aa", "97b6b97bd19801ec9210c965cc920e",  // 1954-1955
  "97bd07f1487f595b0b0bc920fb0722", "7f0e397bd097c36b0b6fc9210c8dc2",  // 1956-1957
  "9778397bd097c36b0b6fc9274c91aa", "97b6b97bd19801ec9210c965cc920e",  // 1958-1959
  "97bcf7f1487f595b0b0bb0b6fb0722", "7f0e397bd097c35b0b6fc920fb0722",  // 1960-1961
  "9778397bd097c36b0b6fc9274c91aa", "97b6b97bd19801ec9210c965cc920e",  // 1962-1963
  "97bcf7f1487f595b0b0bb0b6fb0722", "7f0e397bd097c35b0b6fc920fb0722",  // 1964-1965
  "9778397bd097c36b0b6fc9274c91aa", "97b6b97bd19801ec9210c965cc920e",  // 1966-1967
  "97bcf7f1487f531b0b0bb0b6fb0722", "7f0e397bd097c35b0b6fc920fb0722",  // 1968-1969
  "9778397bd097c36b0b6fc9274c91aa", "97b6b97bd19801ec9210c965cc920e",  // 1970-1971
  "97bcf7f1487f531b0b0bb0b6fb0722", "7f0e397bd07f595b0b6fc920fb0722",  // 1972-1973
  "9778397bd097c36b0b6fc9274c91aa", "97b6b97bd19801ec9210c9274c920e",  // 1974-1975
  "97bcf7f0e47f531b0b0bb0b6fb0722", "7f0e397bd07f595b0b0bc920fb0722",  // 1976-1977
  "9778397bd097c36b0b6fc9210c91aa", "97b6b97bd197c36c9210c9274c920e",  // 1978-1979
  "97bcf7f0e47f531b0b0bb0b6fb0722", "7f0e397bd07f595b0b0bc920fb0722",  // 1980-1981
  "9778397bd097c36b0b6fc9210c8dc2", "9778397bd097c36c9210c9274c920e",  // 1982-1983
  "97b6b7f0e47f531b0723b0b6fb0722", "7f0e37f5307f595b0b0bc920fb0722",  // 1984-1985
  "7f0e397bd097c36b0b6fc9210c8dc2", "9778397bd097c36b0b70c9274c91aa",  // 1986-1987
  "97b6b7f0e47f531b0723b0b6fb0721", "7f0e37f1487f595b0b0bb0b6fb0722",  // 1988-1989
  "7f0e397bd097c35b0b6fc9210c8dc2", "9778397bd097c36b0b6fc9274c91aa",  // 1990-1991
  "97b6b7f0e47f531b0723b0b6fb0721", "7f0e27f1487f595b0b0bb0b6fb0722",  // 1992-1993
  "7f0e397bd097c35b0b6fc920fb0722", "9778397bd097c36b0b6fc9274c91aa",  // 1994-1995
  "97b6b7f0e47f531b0723b0b6fb0721", "7f0e27f1487f531b0b0bb0b6fb0722",  // 1996-1997
  "7f0e397bd097c35b0b6fc920fb0722", "9778397bd097c36b0b6fc9274c91aa",  // 1998-1999
  "97b6b7f0e47f531b0723b0b6fb0721", "7f0e27f1487f531b0b0bb0b6fb0722",  // 2000-2001
  "7f0e397bd097c35b0b6fc920fb0722", "9778397bd097c36b0b6fc9274c91aa",  // 2002-2003
  "97b6b7f0e47f531b0723b0b6fb0721", "7f0e27f1487f531b0b0bb0b6fb0722",  // 2004-2005
  "7f0e397bd07f595b0b0bc920fb0722", "9778397bd097c36b0b6fc9274c91aa",  // 2006-2007
  "97b6b7f0e47f531b0723b0787b0721", "7f0e27f0e47f531b0b0bb0b6fb0722",  // 2008-2009
  "7f0e397bd07f595b0b0bc920fb0722", "9778397bd097c36b0b6fc9210c91aa",  // 2010-2011
  "97b6b7f0e47f149b0723b0787b0721", "7f0e27f0e47f531b0723b0b6fb0722",  // 2012-2013
  "7f0e397bd07f595b0b0bc920fb0722", "9778397bd097c36b0b6fc9210c8dc2",  // 2014-2015
  "977837f0e37f149b0723b0787b0721", "7f07e7f0e47f531b0723b0b6fb0722",  // 2016-2017
  "7f0e37f5307f595b0b0bc920fb0722", "7f0e397bd097c35b0b6fc9210c8dc2",  // 2018-2019
  "977837f0e37f14998082b0787b0721", "7f07e7f0e47f531b0723b0b6fb0721",  // 2020-2021
  "7f0e37f1487f595b0b0bb0b6fb0722", "7f0e397bd097c35b0b6fc9210c8dc2",  // 2022-2023
  "977837f0e37f14998082b0787b06bd", "7f07e7f0e47f531b0723b0b6fb0721",  // 2024-2025
  "7f0e27f1487f531b0b0bb0b6fb0722", "7f0e397bd097c35b0b6fc920fb0722",  // 2026-2027
  "977837f0e37f14998082b0787b06bd", "7f07e7f0e47f531b0723b0b6fb0721",  // 2028-2029
  "7f0e27f1487f531b0b0bb0b6fb0722", "7f0e397bd097c35b0b6fc920fb0722",  // 2030-2031
  "977837f0e37f14998082b0787b06bd", "7f07e7f0e47f531b0723b0b6fb0721",  // 2032-2033
  "7f0e27f1487f531b0b0bb0b6fb0722", "7f0e397bd07f595b0b0bc920fb0722",  // 2034-2035
  "977837f0e37f14998082b0787b06bd", "7f07e7f0e47f531b0723b0b6fb0721",  // 2036-2037
  "7f0e27f1487f531b0b0bb0b6fb0722", "7f0e397bd07f595b0b0bc920fb0722",  // 2038-2039
  "977837f0e37f14998082b0787b06bd", "7f07e7f0e47f149b0723b0787b0721",  // 2040-2041
  "7f0e27f0e47f531b0b0bb0b6fb0722", "7f0e397bd07f595b0b0bc920fb0722",  // 2042-2043
  "977837f0e37f14998082b0723b06bd", "7f07e7f0e37f149b0723b0787b0721",  // 2044-2045
  "7f0e27f0e47f531b0723b0b6fb0722", "7f0e397bd07f595b0b0bc920fb0722",  // 2046-2047
  "977837f0e37f14898082b0723b02d5", "7ec967f0e37f14998082b0787b0721",  // 2048-2049
  "7f07e7f0e47f531b0723b0b6fb0722", "7f0e37f1487f595b0b0bb0b6fb0722",  // 2050-2051
  "7f0e37f0e37f14898082b0723b02d5", "7ec967f0e37f14998082b0787b0721",  // 2052-2053
  "7f07e7f0e47f531b0723b0b6fb0722", "7f0e37f1487f531b0b0bb0b6fb0722",  // 2054-2055
  "7f0e37f0e37f14898082b0723b02d5", "7ec967f0e37f14998082b0787b06bd",  // 2056-2057
  "7f07e7f0e47f531b0723b0b6fb0721", "7f0e37f1487f531b0b0bb0b6fb0722",  // 2058-2059
  "7f0e37f0e37f14898082b072297c35", "7ec967f0e37f14998082b0787b06bd",  // 2060-2061
  "7f07e7f0e47f531b0723b0b6fb0721", "7f0e27f1487f531b0b0bb0b6fb0722",  // 2062-2063
  "7f0e37f0e37f14898082b072297c35", "7ec967f0e37f14998082b0787b06bd",  // 2064-2065
  "7f07e7f0e47f531b0723b0b6fb0721", "7f0e27f1487f531b0b0bb0b6fb0722",  // 2066-2067
  "7f0e37f0e366aa89801eb072297c35", "7ec967f0e37f14998082b0787b06bd",  // 2068-2069
  "7f07e7f0e47f149b0723b0787b0721", "7f0e27f1487f531b0b0bb0b6fb0722",  // 2070-2071
  "7f0e37f0e366aa89801eb072297c35", "7ec967f0e37f14998082b0723b06bd",  // 2072-2073
  "7f07e7f0e47f149b0723b0787b0721", "7f0e27f0e47f531b0723b0b6fb0722",  // 2074-2075
  "7f0e37f0e366aa89801eb072297c35", "7ec967f0e37f14998082b0723b06bd",  // 2076-2077
  "7f07e7f0e37f14998083b0787b0721", "7f0e27f0e47f531b0723b0b6fb0722",  // 2078-2079
  "7f0e37f0e366aa89801eb072297c35", "7ec967f0e37f14898082b0723b02d5",  // 2080-2081
  "7f07e7f0e37f14998082b0787b0721", "7f07e7f0e47f531b0723b0b6fb0722",  // 2082-2083
  "7f0e36665b66aa89801e9808297c35", "665f67f0e37f14898082b0723b02d5",  // 2084-2085
  "7ec967f0e37f14998082b0787b0721", "7f07e7f0e47f531b0723b0b6fb0722",  // 2086-2087
  "7f0e36665b66a449801e9808297c35", "665f67f0e37f14898082b0723b02d5",  // 2088-2089
  "7ec967f0e37f14998082b0787b06bd", "7f07e7f0e47f531b0723b0b6fb0721",  // 2090-2091
  "7f0e36665b66a449801e9808297c35", "665f67f0e37f14898082b072297c35",  // 2092-2093
  "7ec967f0e37f14998082b0787b06bd", "7f07e7f0e47f531b0723b0b6fb0721",  // 2094-2095
  "7f0e26665b66a449801e9808297c35", "665f67f0e37f1489801eb072297c35",  // 2096-2097
  "7ec967f0e37f14998082b0787b06bd", "7f07e7f0e47f531b0723b0b6fb0721",  // 2098-2099
  "7f0e27f1487f531b0b0bb0b6fb0722",  // 2100-2100
};


static const char *const k_gan[10] = {"甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"};
static const char *const k_zhi[12] = {"子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"};
static const char *const k_animal[12] = {"鼠", "牛", "虎", "兔", "龙", "蛇", "马", "羊", "猴", "鸡", "狗", "猪"};
static const char *const k_term[24] = {
    "小寒", "大寒", "立春", "雨水", "惊蛰", "春分", "清明", "谷雨",
    "立夏", "小满", "芒种", "夏至", "小暑", "大暑", "立秋", "处暑",
    "白露", "秋分", "寒露", "霜降", "立冬", "小雪", "大雪", "冬至"};
static const char *const k_month[12] = {"正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "冬", "腊"};
static const char *const k_day_tens[4] = {"初", "十", "廿", "卅"};
static const char *const k_day_unit[10] = {"一", "二", "三", "四", "五", "六", "七", "八", "九", "十"};
// 建除十二值神：index = (日支 - 月建支 + 12) % 12
static const char *const k_jianchu[12] = {"建", "除", "满", "平", "定", "执", "破", "危", "成", "收", "开", "闭"};
// 各值神宜忌（民俗通行简表）
static const char *const k_yi[12] = {
    "出行 上书 见工 会友", "沐浴 清洁 治病 解除", "嫁娶 纳采 开市 立券",
    "修造 平治道涂 粉饰", "冠笄 嫁娶 纳采 修造", "捕捉 立券 交易 纳财",
    "拆卸 破屋 求医 治病", "安床 祭祀 畋猎", "开市 立券 嫁娶 入学",
    "纳财 收藏 立券", "开市 交易 出行 会友", "安葬 修坟 塞穴"};
static const char *const k_ji[12] = {
    "动土 开仓 嫁娶", "嫁娶 出行 搬迁", "安葬 上任 求医", "词讼 出行 栽种",
    "词讼 出行 移徙", "移徙 出行 开市", "嫁娶 开市 出行", "登高 行船 出行",
    "词讼 安葬", "开市 安床 安葬", "安葬 动土 破土", "开市 出行 嫁娶"};
// 彭祖百忌：按日干/日支
static const char *const k_pengzu_gan[10] = {"甲不开仓", "乙不栽植", "丙不修灶", "丁不剃头", "戊不受田",
                                             "己不破券", "庚不经络", "辛不合酱", "壬不汲水", "癸不词讼"};
static const char *const k_pengzu_zhi[12] = {"子不问卜", "丑不冠带", "寅不祭祀", "卯不穿井", "辰不哭泣", "巳不远行",
                                             "午不苫盖", "未不服药", "申不安床", "酉不会客", "戌不吃犬", "亥不嫁娶"};
// 冲煞方位：申子辰煞南，巳酉丑煞东，寅午戌煞北，亥卯未煞西
static const char *const k_shax[4] = {"南", "东", "北", "西"};
static int sha_group(int zhi) { return zhi % 4; }  // 子(0)申(8)辰(4)→0 南；巳(5)酉(9)丑(1)→1 东…

// 天数自 1970-01-01（Howard Hinnant days_from_civil）。
static long days_from_civil(long y, unsigned m, unsigned d) {
  y -= m <= 2;
  const long era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = (unsigned)(y - era * 400);
  const unsigned doy = (153u * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + (long)doe - 719468;
}

static uint32_t year_info(int lunar_year) { return lunar_info[lunar_year - 1900]; }

static int leap_month_of(int lunar_year) { return (int)(year_info(lunar_year) & 0xf); }

static int leap_days_of(int lunar_year) {
  return leap_month_of(lunar_year) ? (year_info(lunar_year) & 0x10000 ? 30 : 29) : 0;
}

static int lunar_year_days(int lunar_year) {
  uint32_t info = year_info(lunar_year);
  int sum = 348;
  for (uint32_t bit = 0x8000; bit >= 0x10; bit >>= 1) sum += (info & bit) ? 1 : 0;
  return sum + leap_days_of(lunar_year);
}

static int lunar_month_days(int lunar_year, int month) {
  if (month < 1 || month > 12) return -1;
  return (year_info(lunar_year) & (0x10000u >> month)) ? 30 : 29;
}

int piko_lunar_solar_days(int y, int m) {
  if (m < 1 || m > 12) return -1;
  static const int k_days[12] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  if (m == 2 && ((y % 4 == 0 && y % 100 != 0) || y % 400 == 0)) return 29;
  return k_days[m - 1];
}

int piko_lunar_weekday(int y, int m, int d) {
  if (y < 1901 || y > 2100 || m < 1 || m > 12 || d < 1 || d > piko_lunar_solar_days(y, m)) return -1;
  long wd = (days_from_civil(y, (unsigned)m, (unsigned)d) + 3) % 7;  // 1970-01-01 周四
  if (wd < 0) wd += 7;  // 1901-1970 的日期为负数，C 取模需修正
  return (int)wd;
}

static void format_day_cn(int day, char *out, size_t n) {
  if (day == 10) { snprintf(out, n, "初十"); return; }
  if (day == 20) { snprintf(out, n, "二十"); return; }
  if (day == 30) { snprintf(out, n, "三十"); return; }
  snprintf(out, n, "%s%s", k_day_tens[day / 10], k_day_unit[day % 10 - 1]);
}

static void format_month_cn(int month, bool leap, char *out, size_t n) {
  snprintf(out, n, "%s%s月", leap ? "闰" : "", k_month[month - 1]);
}

int piko_lunar_from_solar(int y, int m, int d, piko_lunar_date *out) {
  if (!out) return -1;
  memset(out, 0, sizeof(*out));
  if (y < PIKO_LUNAR_YEAR_MIN || y > PIKO_LUNAR_YEAR_MAX || m < 1 || m > 12) return -1;
  if (d < 1 || d > piko_lunar_solar_days(y, m)) return -1;
  long offset = days_from_civil(y, (unsigned)m, (unsigned)d) - days_from_civil(1900, 1, 31);
  if (offset < 0) return -1;
  // 与参考实现一致：offset 恰好归零时 j 已指向下一个农历年（当日是其正月初一）。
  int j = 1900;
  long temp = 0;
  for (; j <= 2100 && offset > 0; j++) {
    temp = lunar_year_days(j);
    offset -= temp;
  }
  if (offset < 0) { offset += temp; j--; }
  int year = j;
  int leap = leap_month_of(year), is_leap = 0;
  int days = 0, i = 0;
  // 与参考实现一致：循环退出后 i 指向目标月的下一个月（offset 归零即初一）。
  for (i = 1; i < 13 && offset > 0; i++) {
    if (leap > 0 && i == leap + 1 && !is_leap) {
      i--;
      is_leap = 1;
      days = leap_days_of(year);
    } else {
      days = lunar_month_days(year, i);
    }
    if (is_leap && i == leap + 1) is_leap = 0;
    offset -= days;
  }
  if (offset == 0 && leap > 0 && i == leap + 1) {
    if (is_leap) is_leap = 0;
    else { is_leap = 1; i--; }
  }
  if (offset < 0) { offset += days; i--; }
  out->year = year;
  out->month = i;
  out->day = (int)offset + 1;
  out->leap = is_leap && out->month == leap;
  // 年干支按农历年，与生肖一致（干支纪日另行计算，见下）。
  int yoff = year - 4;
  snprintf(out->gz_year, sizeof(out->gz_year), "%s%s", k_gan[yoff % 10], k_zhi[yoff % 12]);
  snprintf(out->animal, sizeof(out->animal), "%s", k_animal[(year - 4) % 12]);
  // 日干支：1970-01-01 为甲戌（序位 10）。
  long gz = days_from_civil(y, (unsigned)m, (unsigned)d) + 25577;
  out->day_gan = (int)(gz % 10);
  out->day_zhi = (int)(gz % 12);
  snprintf(out->gz_day, sizeof(out->gz_day), "%s%s", k_gan[out->day_gan], k_zhi[out->day_zhi]);
  format_month_cn(out->month, out->leap, out->month_cn, sizeof(out->month_cn));
  format_day_cn(out->day, out->day_cn, sizeof(out->day_cn));
  return 0;
}

int piko_lunar_term_day(int year, int n) {
  if (year < PIKO_LUNAR_YEAR_MIN - 1 || year > PIKO_LUNAR_YEAR_MAX || n < 1 || n > 24) return -1;
  const char *t = term_info[year - 1900];
  const int group = (n - 1) >> 2, idx = (n - 1) & 3;
  unsigned v = 0;
  for (int k = 0; k < 5; k++) {
    char c = t[group * 5 + k];
    v = (v << 4) | (unsigned)(c <= '9' ? c - '0' : c - 'a' + 10);
  }
  // 每组 5 位十六进制 < 0xF4240，十进制恒为 6 位，按 1/2/1/2 位拆成 4 个节气日。
  char buf[8];
  snprintf(buf, sizeof(buf), "%06u", v);
  if (idx == 0) return buf[0] - '0';
  if (idx == 1) return (buf[1] - '0') * 10 + buf[2] - '0';
  if (idx == 2) return buf[3] - '0';
  return (buf[4] - '0') * 10 + buf[5] - '0';
}

const char *piko_lunar_term_on(int y, int m, int d) {
  if (y < PIKO_LUNAR_YEAR_MIN || y > PIKO_LUNAR_YEAR_MAX || m < 1 || m > 12) return NULL;
  int n = 2 * m - 1;
  if (piko_lunar_term_day(y, n) == d) return k_term[n - 1];
  n = 2 * m;
  if (piko_lunar_term_day(y, n) == d) return k_term[n - 1];
  return NULL;
}

void piko_lunar_festival(int y, int m, int d, const piko_lunar_date *ld, char *out, size_t n) {
  out[0] = '\0';
  if (m == 1 && d == 1) { snprintf(out, n, "元旦"); return; }
  if (m == 3 && d == 8) { snprintf(out, n, "妇女节"); return; }
  if (m == 5 && d == 1) { snprintf(out, n, "劳动节"); return; }
  if (m == 6 && d == 1) { snprintf(out, n, "儿童节"); return; }
  if (m == 10 && d == 1) { snprintf(out, n, "国庆节"); return; }
  piko_lunar_date local;
  if (!ld) {
    if (piko_lunar_from_solar(y, m, d, &local) != 0) return;
    ld = &local;
  }
  if (ld->leap) return;  // 闰月不重复过节
  if (ld->month == 1 && ld->day == 1) { snprintf(out, n, "春节"); return; }
  if (ld->month == 1 && ld->day == 15) { snprintf(out, n, "元宵"); return; }
  if (ld->month == 5 && ld->day == 5) { snprintf(out, n, "端午"); return; }
  if (ld->month == 7 && ld->day == 7) { snprintf(out, n, "七夕"); return; }
  if (ld->month == 8 && ld->day == 15) { snprintf(out, n, "中秋"); return; }
  if (ld->month == 9 && ld->day == 9) { snprintf(out, n, "重阳"); return; }
  if (ld->month == 12 && ld->day == 8) { snprintf(out, n, "腊八"); return; }
  // 除夕：腊月最后一天（1900-2100 无闰腊月）
  if (ld->month == 12 && !ld->leap) {
    if (ld->day == lunar_month_days(ld->year, 12)) snprintf(out, n, "除夕");
  }
}

void piko_lunar_almanac(int y, int m, int d, const piko_lunar_date *ld,
                        char *yi, size_t yi_n, char *ji, size_t ji_n,
                        char *note, size_t note_n, char *pengzu, size_t pz_n) {
  piko_lunar_date local;
  if (!ld) {
    if (piko_lunar_from_solar(y, m, d, &local) != 0) {
      if (yi_n) yi[0] = '\0';
      if (ji_n) ji[0] = '\0';
      if (note_n) note[0] = '\0';
      if (pz_n) pengzu[0] = '\0';
      return;
    }
    ld = &local;
  }
  // 日干支序位直接来自农历换算结果
  int gz = ld->day_gan, zhi = ld->day_zhi;
  // 月建：正月寅、二月卯 … 十一月子、十二月丑；闰月随本月。
  int month_zhi = (ld->month + 1) % 12;
  int jc = (zhi - month_zhi + 12) % 12;
  int chong = (zhi + 6) % 12;
  snprintf(note, note_n, "冲%s煞%s · 建除「%s」", k_animal[chong], k_shax[sha_group(zhi)], k_jianchu[jc]);
  snprintf(pengzu, pz_n, "%s · %s", k_pengzu_gan[gz], k_pengzu_zhi[zhi]);
  snprintf(yi, yi_n, "%s", k_yi[jc]);
  snprintf(ji, ji_n, "%s", k_ji[jc]);
}
