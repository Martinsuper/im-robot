#pragma once
#include "FreeRTOS.h"
void vTaskDelay(uint32_t ms);
int xTaskCreate(void (*fn)(void *),const char *,unsigned,void *,unsigned,void *);

void vTaskDelete(void *task);
