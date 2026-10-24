#pragma once
#include "FreeRTOS.h"
#include <stddef.h>
typedef void *QueueHandle_t;
QueueHandle_t xQueueCreate(unsigned count,size_t size);
int xQueueSend(QueueHandle_t,const void *,uint32_t);
int xQueueReceive(QueueHandle_t,void *,uint32_t);
void xQueueReset(QueueHandle_t);
void vQueueDelete(QueueHandle_t);
