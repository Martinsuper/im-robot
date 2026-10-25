#pragma once
#include <stdint.h>
#include "esp_err.h"
typedef int nvs_handle_t;
#define NVS_READWRITE 1
#define NVS_READONLY 0
static inline int nvs_open(const char*n,int m,nvs_handle_t*h){(void)n;(void)m;(void)h;return ESP_FAIL;}
static inline int nvs_get_u8(nvs_handle_t h,const char*n,uint8_t*v){(void)h;(void)n;(void)v;return ESP_FAIL;}
static inline int nvs_set_u8(nvs_handle_t h,const char*n,uint8_t v){(void)h;(void)n;(void)v;return ESP_OK;}
static inline int nvs_commit(nvs_handle_t h){(void)h;return ESP_OK;}
static inline void nvs_close(nvs_handle_t h){(void)h;}
