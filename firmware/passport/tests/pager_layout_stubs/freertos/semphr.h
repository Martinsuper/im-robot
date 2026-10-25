#pragma once
#include "FreeRTOS.h"
typedef void *SemaphoreHandle_t;
static inline SemaphoreHandle_t xSemaphoreCreateMutex(void){return (void*)1;}
static inline void xSemaphoreTake(SemaphoreHandle_t m,unsigned t){(void)m;(void)t;}
static inline void xSemaphoreGive(SemaphoreHandle_t m){(void)m;}
