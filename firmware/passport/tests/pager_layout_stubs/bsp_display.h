#pragma once
#include <stdbool.h>
static inline bool bsp_lvgl_lock(unsigned wait){(void)wait;return true;}
static inline void bsp_lvgl_unlock(void){}
static inline void bsp_display_backlight(unsigned value){(void)value;}
