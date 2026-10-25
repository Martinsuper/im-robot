#!/usr/bin/env python3
"""Validate the production new-peer gate and physical pairing window."""
from pathlib import Path
import subprocess,tempfile
root=Path(__file__).resolve().parents[1]
s=(root/'main/pager_ble.c').read_text()
def function(signature):
 a=s.index(signature);return s[a:s.index('\n}',a)+2]
harness=r'''
#include <assert.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
typedef uint32_t TickType_t;
typedef struct {uint8_t id;} ble_addr_t;
static TickType_t ticks,s_window_until;
static int bonds=1;
#define pdMS_TO_TICKS(x) (x)
#define ESP_LOGI(...) ((void)0)
static TickType_t xTaskGetTickCount(void){return ticks;}
static int ble_store_util_bonded_peers(ble_addr_t *out,int *n,int cap){assert(cap==8);*n=bonds;for(int i=0;i<bonds;i++)out[i].id=i+1;return 0;}
static int ble_addr_cmp(const ble_addr_t*a,const ble_addr_t*b){return a->id-b->id;}
FUNCTIONS
int main(void){
 ble_addr_t computer={1},phone={2};
 assert(pairing_allowed(&computer));assert(!pairing_allowed(&phone));
 pager_ble_open_pairing_window(120000);assert(pager_ble_pairing_open());
 assert(pairing_allowed(&phone));ticks=120001;
 assert(!pager_ble_pairing_open()&&!pairing_allowed(&phone));
 assert(pairing_allowed(&computer));bonds=0;assert(pairing_allowed(&phone));
 ticks=UINT32_MAX-10000;pager_ble_open_pairing_window(120000);
 assert(pairing_allowed(&phone));bonds=1;ticks+=119999;assert(pairing_allowed(&phone));
 ticks+=2;assert(!pairing_allowed(&phone));
 puts("PASS: saved peer reconnect, new peer admission only within physical window, expiry and tick rollover");
}
'''.replace('FUNCTIONS','\n'.join(function(t) for t in ['void pager_ble_open_pairing_window(', 'bool pager_ble_pairing_open(', 'static bool pairing_allowed(const ble_addr_t *peer)\n{']))
with tempfile.TemporaryDirectory(prefix='piko-pairing-') as temp:
 src=Path(temp)/'test.c';src.write_text(harness);binary=Path(temp)/'test'
 subprocess.run(['cc','-std=c11','-Wall','-Wextra','-Werror',str(src),'-o',str(binary)],check=True)
 subprocess.run([str(binary)],check=True,timeout=10)
