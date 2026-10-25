#pragma once
#include <stdint.h>
extern int64_t pager_layout_now;
static inline int64_t esp_timer_get_time(void){return pager_layout_now;}
