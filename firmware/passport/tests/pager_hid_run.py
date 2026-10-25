#!/usr/bin/env python3
"""Test actual HID report construction and ready/error gating."""
from pathlib import Path
import subprocess
import tempfile
root=Path(__file__).resolve().parents[1]
source=(root/'main/pager_ble.c').read_text()
def extract(signature):
    a=source.index(signature)
    return source[a:source.index('\n}',a)+2]
harness=r'''
#include <assert.h>
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <string.h>
#include <stdio.h>
#include "pager_keys.h"
#define ESP_OK 0
#define pdMS_TO_TICKS(x) (x)
enum {PAGER_BLE_ADVERTISING,PAGER_BLE_CONNECTED,PAGER_BLE_READY};
static int s_state;
static void *s_dev;
static unsigned calls,delay_count;
static int fail_call;
static uint8_t reports[4][8];
static size_t sizes[4],ids[4];
static int esp_hidd_dev_input_set(void *dev,int map,int id,const uint8_t *r,size_t n){
 assert(dev&&map==0&&calls<4&&n<=8);
 memcpy(reports[calls],r,n);sizes[calls]=n;ids[calls]=id;calls++;
 return calls==(unsigned)fail_call?-1:0;
}
static void vTaskDelay(int ms){assert(ms==30);delay_count++;}
FUNCTIONS
static void reset(void){calls=delay_count=0;fail_call=0;memset(reports,0,sizeof(reports));}
int main(void){
 pager_key_t key=pager_key_for(PAGER_MODE_ARROW,PAGER_NEXT);
 s_dev=(void *)1;
 for(s_state=0;s_state<PAGER_BLE_READY;s_state++){reset();assert(!pager_ble_tap(key)&&calls==0);}
 s_state=PAGER_BLE_READY;s_dev=NULL;assert(!pager_ble_tap(key));s_dev=(void *)1;
 reset();assert(pager_ble_tap(key)&&calls==2&&delay_count==1);
 assert(sizes[0]==8&&ids[0]==PAGER_RPT_KEYBOARD&&reports[0][2]==0x4f);
 for(unsigned i=0;i<sizes[1];i++)assert(reports[1][i]==0);
 reset();key=pager_key_for(PAGER_MODE_VOLUME,PAGER_NEXT);assert(pager_ble_tap(key));
 assert(sizes[0]==2&&ids[0]==PAGER_RPT_CONSUMER&&reports[0][0]==0xea);
 reset();fail_call=1;assert(!pager_ble_tap(key)&&calls==2&&delay_count==0);
 reset();fail_call=2;assert(!pager_ble_tap(key)&&calls==2);
 puts("PASS: HID readiness, keyboard/media reports, key release and transmission errors");
}
'''.replace('FUNCTIONS',extract('static bool send(')+'\n'+extract('bool pager_ble_tap('))
with tempfile.TemporaryDirectory(prefix='piko-hid-') as temp:
    src=Path(temp)/'test.c';src.write_text(harness);binary=Path(temp)/'test'
    subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror',f'-I{root/"main"}',str(src),str(root/'main/pager_keys.c'),'-o',str(binary)],check=True)
    subprocess.run([str(binary)],check=True,timeout=10)
